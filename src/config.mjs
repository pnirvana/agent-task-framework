// ATF's config files (TOML, see toml.mjs): where they are, and the commented templates
// `atf config init` writes (every option, at its default, commented out).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from './core.mjs';

/** Your own settings: ~/.config/atf (or $XDG_CONFIG_HOME/atf). */
export const userConfigDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'atf');
/** The herdr plugin's settings: $HERDR_PLUGIN_CONFIG_DIR, as herdr sets it for the plugin. */
export const pluginConfigDir = () => process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(os.homedir(), '.config/herdr/plugins/config/atf.herdr');

export const PROJECT_TEMPLATE = `# ATF project config (atf config shows the files in use)
protocol = ${PROTOCOL_VERSION}

# Where a task's changed files come from (atf diff, the board's Changes tab):
# "snapshots" (default: git snapshots when a task starts and when it ends) or
# "artifacts" (only the file, commit and branch artifacts agents report)
# changes = "snapshots"

# [hooks] is written by atf-herdr enable-sync / disable-sync
`;

export const USER_TEMPLATE = `# ATF: your own settings (atf config shows the files in use).
# Everything is optional: uncomment what you want to change.

[diff]
# The viewer for atf diff --open and the board's d / D: "git" (git diff in less),
# "diffview" (Neovim's diffview.nvim), "difftool" (git difftool --dir-diff), or a command
# with {repo} {base} {target} {range} {files}. $ATF_DIFF_TOOL overrides it.
# tool = "git"

[notify]
# Notifications when you are needed (what the board shows as "needs you").
# herdr = true                               # herdr's own notification ([ui.toast] in herdr's config)
# terminal = ["toast", "bell", "progress"]   # written to the terminal herdr runs in, also over SSH:
#                                            # toast = OSC 777 (Windows Terminal 1.26+), bell = BEL,
#                                            # progress = OSC 9;4 tab/taskbar mark (default: none)
# command = 'curl -d "$ATF_NOTIFY_BODY" ntfy.sh/<topic>'   # also $ATF_NOTIFY_TITLE, $ATF_NOTIFY_COUNT
# settle_seconds = 5                         # an agent waiting / no coordinator must hold this long
`;

export const PLUGIN_TEMPLATE = `# ATF herdr plugin settings (atf config shows the files in use).
# Everything is optional: uncomment what you want to change.

# agent_kind = "pi"          # pi | copilot | opencode | claude | codex (spawn / coordinate --kind)
# agent_placement = "tab"    # tab: agents in the workspace's "agents" tab | split: beside the coordinator
# lifecycle = "ephemeral"    # ephemeral: close agents once they finished | persistent: keep them open
# board_placement = "auto"   # auto: full-height right column | beside: split a pane | tab
# board_start = "overview"   # overview: all projects | plan: this project's plan
# vi_mode = false            # vi keys in the board's text fields
# plans_dir = "~/plans"      # atf-herdr new <name>: the plan's folder is created here
# new_plan_agent = ""        # agent definition for a new plan's coordinator (atf-herdr agents)
# new_plan_prompt = ""       # its first message (empty: you start the discussion)
# restore = "auto"           # auto: restore coordinators and boards when herdr starts | off

# Agent kinds, to override or add. Arguments with {skill} are dropped once the skill is
# installed (atf skill install); {session} is the session to resume.
# [agents]
# pi = { start = ["--skill", "{skill}"], resume = ["--session", "{session}", "--skill", "{skill}"], nativeSkill = true }
# claude = { start = [], resume = ["--resume", "{session}"] }
`;

/** The config places: what, directory, template (header lines for a file ATF writes). */
export function configPlaces(projectRoot = null) {
  return [
    ...(projectRoot ? [{ what: 'project', dir: projectRoot, template: PROJECT_TEMPLATE }] : []),
    { what: 'user', dir: userConfigDir(), template: USER_TEMPLATE },
    { what: 'plugin', dir: pluginConfigDir(), template: PLUGIN_TEMPLATE },
  ].map((p) => ({ ...p, header: p.template.split('\n').filter((l) => l.startsWith('# ')).slice(0, 1).join('\n') + '\n\n' }));
}

/** Write a place's template as <dir>/config.toml; never over an existing file. */
export function initConfigFile(place) {
  const file = path.join(place.dir, 'config.toml');
  if (fs.existsSync(file)) return { file, created: false };
  fs.mkdirSync(place.dir, { recursive: true });
  fs.writeFileSync(file, place.template, { flag: 'wx' });
  return { file, created: true };
}
