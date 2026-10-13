import { api, ApiError, MAX_YAML_LENGTH, type GlobalConfig } from "../api"
import { field, h, replace, toast } from "../dom"
import { button, linkButton } from "../shared"

export async function renderGlobalConfig(main: HTMLElement) {
  let config = await api.get<GlobalConfig>("/api/config/global")
  const source = h(
    "textarea",
    { id: "global-config-yaml", class: "input input-mono", rows: 24, spellcheck: "false", maxlength: MAX_YAML_LENGTH },
    config.yaml,
  )
  const revision = h("p", { class: "hint", role: "status" }, `Saved revision ${config.revision}`)
  const error = h("p", { class: "notice", "data-tone": "error", role: "alert", hidden: true })
  const acknowledge = h("input", { type: "checkbox" })
  const save = button("Save global config", { type: "submit", variant: "primary", disabled: true })
  acknowledge.addEventListener("change", () => {
    save.disabled = !acknowledge.checked
  })
  const reload = button("Reload saved config", {
    onclick: async () => {
      reload.disabled = true
      try {
        config = await api.get<GlobalConfig>("/api/config/global")
        source.value = config.yaml
        replace(revision, `Saved revision ${config.revision}`)
        error.hidden = true
      } catch (failure) {
        error.hidden = false
        replace(error, failure instanceof ApiError ? failure.message : "Could not reload global config. Try again.")
      } finally {
        reload.disabled = false
      }
    },
  })
  const form = h(
    "form",
    { class: "panel" },
    h(
      "div",
      { class: "panel-body stack" },
      field(
        "Global config YAML",
        source,
        "Use version: 1, permissions, and optional defaults. Only agents that select this config inherit its permission rules, starting with their next run. Defaults fill unset fields when creating an agent.",
      ),
      h(
        "p",
        { class: "hint" },
        "Defaults: task, os_shell, location_label, model_provider, model_name, interactive, permission_mode, permission_request_timeout_seconds and declared_env_vars. Keep API keys and other credentials in the agent's secret fields.",
      ),
      h(
        "details",
        {},
        h("summary", {}, "Example global YAML"),
        h(
          "pre",
          { class: "well" },
          "version: 1\ndefaults:\n  model_provider: anthropic\n  model_name: your-model-id\n  permission_mode: request\npermissions:\n  - path_pattern: ./secrets\n    kind: filesystem\n    access: read\n    effect: deny\n",
        ),
      ),
      h(
        "label",
        { class: "check" },
        acknowledge,
        "I understand that granting commands such as interpreters can make path rules advisory.",
      ),
      revision,
      error,
      h("div", { class: "actions" }, save, reload),
    ),
  )
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (!acknowledge.checked || save.disabled) return
    save.disabled = true
    acknowledge.disabled = true
    reload.disabled = true
    error.hidden = true
    try {
      config = await api.put<GlobalConfig>("/api/config/global", {
        yaml: source.value,
        revision: config.revision,
        acknowledge_bash_gateways: acknowledge.checked,
      })
      replace(revision, `Saved revision ${config.revision}`)
      toast("Global config saved. Shared rule changes apply to the next run.")
    } catch (failure) {
      error.hidden = false
      replace(error, failure instanceof ApiError ? failure.message : "Could not save global config. Try again.")
    } finally {
      save.disabled = !acknowledge.checked
      acknowledge.disabled = false
      reload.disabled = false
    }
  })
  replace(
    main,
    h(
      "div",
      { class: "masthead" },
      h(
        "div",
        { class: "masthead-text" },
        h("h1", {}, "Global config"),
        h("p", {}, "Reusable permissions and agent defaults for this control plane."),
      ),
      linkButton("New agent", "#/new"),
    ),
    form,
  )
}
