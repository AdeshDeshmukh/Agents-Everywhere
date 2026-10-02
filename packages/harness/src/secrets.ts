/**
 * Resolves secret references into environment variables for the agent, on the
 * machine itself, with whatever identity the machine already has. A config
 * holds only references (an ARN, a resource name, a Vault path, an env var
 * name), so a value never passes through the control plane.
 *
 * No SDKs: the runner is dependency-free, so AWS requests are signed by hand
 * with SigV4 using only Node's own https and crypto, following AWS's published
 * steps (canonical request, string to sign, derived signing key, signature).
 *
 * Nothing here ever logs a value. The reference and the variable names are
 * safe to print; the thing they point at is the whole point of not printing it.
 */
import crypto from "crypto"
import fs from "fs"
import { brand } from "./brand"
import { rawRequest } from "./http"
import type { SecretMapping } from "./protocol"

type OnLine = (line: string) => void
type EnvVars = Record<string, string>

interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex")
}

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest()
}

// AWS SigV4, steps and formulas exactly as published at
// docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html.
// `headers` keys must already be lowercase; the only caller passes them that way.
export function signSigV4(input: {
  method: string
  host: string
  path: string
  region: string
  service: string
  headers: Record<string, string>
  body: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  now?: Date
}): Record<string, string> {
  const amzDate = (input.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "")
  const dateStamp = amzDate.slice(0, 8)

  const allHeaders: Record<string, string> = { ...input.headers, host: input.host, "x-amz-date": amzDate }
  if (input.sessionToken) allHeaders["x-amz-security-token"] = input.sessionToken

  const signedHeaderNames = Object.keys(allHeaders).sort()
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${String(allHeaders[k]).trim()}\n`).join("")
  const signedHeaders = signedHeaderNames.join(";")
  const hashedPayload = sha256Hex(input.body || "")

  const canonicalRequest = [input.method, input.path, "", canonicalHeaders, signedHeaders, hashedPayload].join("\n")

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n")

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, input.service)
  const kSigning = hmac(kService, "aws4_request")
  const signature = hmac(kSigning, stringToSign).toString("hex")

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    ...input.headers,
    host: input.host,
    "x-amz-date": amzDate,
    ...(input.sessionToken ? { "x-amz-security-token": input.sessionToken } : {}),
    Authorization: authorization,
  }
}

// EKS IRSA: AssumeRoleWithWebIdentity needs no signing, the identity comes from
// the token itself. The response is XML with no nesting for the fields needed,
// so a small targeted extractor is enough.
function extractXmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return match ? match[1] : null
}

async function tryIrsaCredentials(onLine: OnLine): Promise<AwsCredentials | null> {
  const roleArn = process.env.AWS_ROLE_ARN
  const tokenFile = process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  if (!roleArn || !tokenFile) return null
  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim()
    const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
    const params = new URLSearchParams({
      Action: "AssumeRoleWithWebIdentity",
      RoleArn: roleArn,
      RoleSessionName: brand().name,
      WebIdentityToken: token,
      Version: "2011-06-15",
    })
    const res = await rawRequest(`https://sts.${region}.amazonaws.com/?${params.toString()}`, {
      method: "POST",
      timeoutMs: 5000,
    })
    if (res.status < 200 || res.status >= 300) {
      onLine(`IRSA credential exchange failed (HTTP ${res.status})`)
      return null
    }
    const accessKeyId = extractXmlField(res.body, "AccessKeyId")
    const secretAccessKey = extractXmlField(res.body, "SecretAccessKey")
    const sessionToken = extractXmlField(res.body, "SessionToken")
    if (!accessKeyId || !secretAccessKey || !sessionToken) return null
    return { accessKeyId, secretAccessKey, sessionToken }
  } catch (err) {
    onLine(`IRSA credential exchange failed: ${err}`)
    return null
  }
}

async function tryImdsCredentials(): Promise<AwsCredentials | null> {
  try {
    const tokenRes = await rawRequest("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
      timeoutMs: 1500,
    })
    if (tokenRes.status < 200 || tokenRes.status >= 300) return null
    const imdsToken = tokenRes.body.trim()

    const roleRes = await rawRequest("http://169.254.169.254/latest/meta-data/iam/security-credentials/", {
      headers: { "X-aws-ec2-metadata-token": imdsToken },
      timeoutMs: 1500,
    })
    const roleName = roleRes.body.trim().split("\n")[0]
    if (!roleName) return null

    const credsRes = await rawRequest(`http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`, {
      headers: { "X-aws-ec2-metadata-token": imdsToken },
      timeoutMs: 1500,
    })
    const creds = JSON.parse(credsRes.body)
    if (!creds.AccessKeyId || !creds.SecretAccessKey || !creds.Token) return null
    return { accessKeyId: creds.AccessKeyId, secretAccessKey: creds.SecretAccessKey, sessionToken: creds.Token }
  } catch {
    // No IMDS reachable: not an EC2 instance, or IMDS is disabled. That is the
    // normal case for a laptop or most CI runners, and the short timeouts above
    // keep it fast.
    return null
  }
}

/**
 * Tries, in order: static credentials already in the environment, EKS IRSA,
 * then EC2 instance-profile credentials via IMDSv2. Null when none are
 * available; callers treat that as "skip this secret" rather than fatal.
 */
async function resolveAwsCredentials(onLine: OnLine): Promise<AwsCredentials | null> {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
    }
  }
  const irsa = await tryIrsaCredentials(onLine)
  if (irsa) return irsa
  return tryImdsCredentials()
}

function parseArnRegion(arn: string): string {
  // arn:aws:secretsmanager:<region>:<account-id>:secret:<name>
  return arn.split(":")[3] || "us-east-1"
}

async function fetchAwsSecretEnvVars(
  secretArn: string,
  keyToEnvVar: Record<string, string>,
  credentials: AwsCredentials,
  onLine: OnLine,
): Promise<EnvVars> {
  const region = parseArnRegion(secretArn)
  const host = `secretsmanager.${region}.amazonaws.com`
  const body = JSON.stringify({ SecretId: secretArn })
  const headers = signSigV4({
    method: "POST",
    host,
    path: "/",
    region,
    service: "secretsmanager",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "secretsmanager.GetSecretValue",
    },
    body,
    ...credentials,
  })

  const res = await rawRequest(`https://${host}/`, { method: "POST", headers, body, timeoutMs: 8000 })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GetSecretValue failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`)
  }

  const secretString = JSON.parse(res.body).SecretString
  if (secretString === undefined) {
    throw new Error("Secret has no SecretString (binary secrets aren't supported)")
  }
  return mapSecretToEnvVars(secretArn, secretString, keyToEnvVar, onLine)
}

/**
 * Turns one fetched secret into environment variables, the same way for every
 * provider: a JSON object is read key by key, and a plain string is usable only
 * when exactly one variable was asked for it.
 */
export function mapSecretToEnvVars(
  reference: string,
  secretString: string,
  keyToEnvVar: Record<string, string>,
  onLine: OnLine,
): EnvVars {
  let asObject: Record<string, unknown> | null
  try {
    asObject = JSON.parse(secretString)
  } catch {
    asObject = null
  }

  const envVars: EnvVars = {}
  const entries = Object.entries(keyToEnvVar)
  if (asObject && typeof asObject === "object") {
    for (const [key, envVar] of entries) {
      if (asObject[key] !== undefined) envVars[envVar] = String(asObject[key])
      else onLine(`Secret ${reference} has no key ${JSON.stringify(key)}, ${envVar} won't be set`)
    }
  } else if (entries.length === 1) {
    envVars[entries[0][1]] = secretString
  } else {
    onLine(
      `Secret ${reference} isn't a JSON object with multiple keys, but ${entries.length} env vars were requested for it`,
    )
  }
  return envVars
}

/**
 * GCP Secret Manager, via the instance metadata server for the token. The
 * metadata server hands out a ready-made OAuth token, so there is nothing to
 * sign: the machine's own service account is the identity.
 */
async function fetchGcpSecretEnvVars(secret: SecretMapping, onLine: OnLine): Promise<EnvVars> {
  const config = secret.provider_config || {}
  const version = config.version || "latest"
  // Accepts either a bare secret id plus a project, or the full resource name.
  const name = secret.secret_arn.startsWith("projects/")
    ? secret.secret_arn
    : `projects/${config.project || ""}/secrets/${secret.secret_arn}`
  if (name.includes("projects//")) {
    throw new Error("GCP secrets need a project in provider_config, or a full projects/... resource name")
  }

  const tokenRes = await rawRequest(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, timeoutMs: 5000 },
  )
  if (tokenRes.status !== 200) {
    throw new Error(
      `GCP metadata server returned HTTP ${tokenRes.status}, is this machine on GCP with a service account?`,
    )
  }
  const token = JSON.parse(tokenRes.body).access_token
  if (!token) throw new Error("GCP metadata server returned no access token")

  const res = await rawRequest(`https://secretmanager.googleapis.com/v1/${name}/versions/${version}:access`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 8000,
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Secret Manager access failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`)
  }
  const payload = JSON.parse(res.body).payload || {}
  if (!payload.data) throw new Error("Secret version has no data")
  const secretString = Buffer.from(payload.data, "base64").toString("utf8")
  return mapSecretToEnvVars(name, secretString, secret.key_to_env_var, onLine)
}

/**
 * HashiCorp Vault KV v2. The token comes from VAULT_TOKEN when the machine
 * already has one, or from Kubernetes auth using the pod's own projected
 * service-account token, the equivalent of an instance profile for a cluster.
 */
async function resolveVaultToken(config: Record<string, any>, onLine: OnLine): Promise<string | null> {
  if (process.env.VAULT_TOKEN) return process.env.VAULT_TOKEN

  const address = config.address || process.env.VAULT_ADDR
  const role = config.role
  const jwtPath = config.jwt_path || "/var/run/secrets/kubernetes.io/serviceaccount/token"
  if (!address || !role) return null

  let jwt: string
  try {
    jwt = fs.readFileSync(jwtPath, "utf8").trim()
  } catch {
    onLine(`No VAULT_TOKEN and no service-account token at ${jwtPath}, cannot authenticate to Vault.`)
    return null
  }

  const authMount = config.auth_mount || "kubernetes"
  const res = await rawRequest(`${String(address).replace(/\/$/, "")}/v1/auth/${authMount}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, jwt }),
    timeoutMs: 8000,
  })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Vault login failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`)
  }
  return (JSON.parse(res.body).auth || {}).client_token || null
}

async function fetchVaultSecretEnvVars(secret: SecretMapping, onLine: OnLine): Promise<EnvVars> {
  const config = secret.provider_config || {}
  const address = config.address || process.env.VAULT_ADDR
  if (!address) throw new Error("Vault secrets need an address in provider_config, or VAULT_ADDR on the machine")

  const token = await resolveVaultToken(config, onLine)
  if (!token) throw new Error("No Vault token available on this machine")

  const mount = config.mount || "secret"
  const secretPath = config.path || secret.secret_arn
  const url = `${String(address).replace(/\/$/, "")}/v1/${mount}/data/${String(secretPath).replace(/^\//, "")}`
  const res = await rawRequest(url, { headers: { "X-Vault-Token": token }, timeoutMs: 8000 })
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Vault read failed (HTTP ${res.status}): ${res.body.slice(0, 300)}`)
  }
  // KV v2 nests the actual key/value pairs under data.data.
  const data = (JSON.parse(res.body).data || {}).data || {}
  return mapSecretToEnvVars(`${mount}/${secretPath}`, JSON.stringify(data), secret.key_to_env_var, onLine)
}

/** A value the machine's environment already carries. Nothing is fetched; this
 *  only renames what is there. */
function fetchEnvSecretEnvVars(secret: SecretMapping, onLine: OnLine): EnvVars {
  const source = secret.secret_arn
  const value = process.env[source]
  if (value === undefined) {
    onLine(`Environment variable ${source} is not set on this machine, nothing to map from it.`)
    return {}
  }
  return mapSecretToEnvVars(source, value, secret.key_to_env_var, onLine)
}

/**
 * Resolves every configured secret into env vars to hand the agent process.
 * Best-effort per secret: a bad reference or a missing permission is said out
 * loud and that one secret is skipped, because a task that does not need it
 * should not be blocked by it.
 */
export async function resolveSecretEnvVars(secrets: SecretMapping[], onLine: OnLine): Promise<EnvVars> {
  const envVars: EnvVars = {}
  if (!secrets || secrets.length === 0) return envVars

  // Resolved once, and only if something needs it: a config that uses Vault on
  // a machine with no AWS identity should not log an AWS failure.
  let awsCredentials: AwsCredentials | null | undefined
  const awsCredentialsOnce = async () => {
    if (awsCredentials === undefined) awsCredentials = (await resolveAwsCredentials(onLine)) || null
    return awsCredentials
  }

  for (const secret of secrets) {
    const provider = secret.provider || "aws"
    try {
      if (provider === "aws") {
        const credentials = await awsCredentialsOnce()
        if (!credentials) {
          onLine(
            `No AWS credentials on this machine (no static credentials, IRSA, or instance profile), ` +
              `skipping ${secret.secret_arn}.`,
          )
          continue
        }
        Object.assign(
          envVars,
          await fetchAwsSecretEnvVars(secret.secret_arn, secret.key_to_env_var, credentials, onLine),
        )
      } else if (provider === "gcp") {
        Object.assign(envVars, await fetchGcpSecretEnvVars(secret, onLine))
      } else if (provider === "vault") {
        Object.assign(envVars, await fetchVaultSecretEnvVars(secret, onLine))
      } else if (provider === "env") {
        Object.assign(envVars, fetchEnvSecretEnvVars(secret, onLine))
      } else {
        onLine(`Unknown secret provider ${JSON.stringify(provider)}, skipping ${secret.secret_arn}.`)
      }
    } catch (err) {
      onLine(`Could not fetch secret ${secret.secret_arn} from ${provider}: ${err}`)
    }
  }
  return envVars
}
