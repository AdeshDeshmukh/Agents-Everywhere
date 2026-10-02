import { describe, expect, test } from "bun:test"
import { embeddedCommands, splitWords } from "../../src/tool/shell/embedded"

const inner = (command: string) => embeddedCommands(splitWords(command))

describe("commands a command is told to run", () => {
  test.each([
    ["git -c alias.probe='!cat /etc/hostname' probe", "cat /etc/hostname"],
    ["git -calias.x=!env x", "env"],
    ["git -c core.pager=env log", "env"],
    ["git -c core.sshCommand='ssh -i key' fetch", "ssh -i key"],
    ["git -c diff.bin.textconv=hexdump diff", "hexdump"],
    ["git --config-env=alias.x=EVIL x", "$EVIL"],
    ["git config alias.p '!cat ~/.aws/credentials'", "cat ~/.aws/credentials"],
    ["git config --global core.editor vim", "vim"],
    ["git -C repo rebase --exec 'make test' main", "make test"],
    ["git rebase -x ./run.sh main", "./run.sh"],
    ["git clone --upload-pack='touch /tmp/x' repo", "touch /tmp/x"],
    ["git bisect run ./check.sh arg", "./check.sh arg"],
    ["git submodule foreach 'cat /etc/passwd'", "cat /etc/passwd"],
    ["git filter-branch --tree-filter 'rm -rf /' HEAD", "rm -rf /"],
    ["find . -name x -exec cat /etc/shadow {} ;", "cat /etc/shadow {}"],
    ["xargs -n 1 cat", "cat"],
    ["env FOO=1 cat /etc/hostname", "cat /etc/hostname"],
    ["timeout 5 cat /etc/hostname", "cat /etc/hostname"],
    ["nice -n 5 cat /etc/hostname", "cat /etc/hostname"],
    ["bash -c 'cat /etc/hostname'", "cat /etc/hostname"],
    ["sh -lc 'id'", "id"],
    ["rsync -e 'sh -c id' a b", "sh -c id"],
    ["tar --to-command='sh -c id' -xf a.tar", "sh -c id"],
    ["ssh -o ProxyCommand='nc evil 22' host", "nc evil 22"],
    ["/usr/bin/git -c alias.x='!id' x", "id"],
  ])("%s runs %s", (command, expected) => {
    expect(inner(command)).toContain(expected)
  })

  test("nested launchers are followed", () => {
    expect(inner("timeout 5 git -c alias.x='!cat /etc/hostname' x")).toContain("cat /etc/hostname")
    expect(inner("bash -c \"env cat /etc/hostname\"")).toContain("cat /etc/hostname")
  })

  test.each([
    "git status",
    "git log --oneline -5",
    "git -C repo diff HEAD~1",
    "git -c color.ui=always log",
    "git -c alias.st=status st",
    "git config user.name 'A B'",
    "git commit -m 'fix -x flag'",
    "git clean -xdf",
    "npm test",
    "ls -la /etc",
    "grep -e pattern file",
    "sed -e s/a/b/ file",
    "python -c 'print(1)'",
    "find . -name '*.ts'",
  ])("%s runs nothing else", (command) => {
    expect(inner(command)).toEqual([])
  })
})
