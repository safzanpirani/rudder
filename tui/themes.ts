import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openCodeThemes } from "./opencode-themes";

export interface ThemePalette {
  background: string;
  panel: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  selected: string;
  danger: string;
  success: string;
  warning: string;
}

export interface ThemeDefinition {
  name: string;
  label: string;
  source: "Rudder" | "OpenCode";
  palette: ThemePalette;
}

export interface TUIConfig {
  theme?: string;
  diffTreeWidth?: number;
}

export const defaultThemeName = "rudder";

const rudderPalette: ThemePalette = {
  background: "#101318",
  panel: "#171b22",
  border: "#343b48",
  text: "#d9dee8",
  dim: "#77808f",
  accent: "#67d4ff",
  selected: "#25384a",
  danger: "#ff6b72",
  success: "#7bd88f",
  warning: "#f4c95d",
};

const displayNames: Record<string, string> = {
  "catppuccin-frappe": "Catppuccin Frappé",
  "catppuccin-macchiato": "Catppuccin Macchiato",
  "cobalt2": "Cobalt2",
  "github": "GitHub",
  "lucent-orng": "Lucent ORNG",
  "nightowl": "Night Owl",
  "one-dark": "One Dark",
  "opencode": "OpenCode",
  "orng": "ORNG",
  "osaka-jade": "Osaka Jade",
  "rosepine": "Rosé Pine",
  "synthwave84": "Synthwave '84",
  "tokyonight": "Tokyo Night",
  "zenburn": "Zenburn",
};

function titleCase(name: string): string {
  return name
    .split("-")
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

export const themes: ThemeDefinition[] = [
  {
    name: defaultThemeName,
    label: "Rudder",
    source: "Rudder",
    palette: rudderPalette,
  },
  ...Object.entries(openCodeThemes).map(([name, palette]) => ({
    name,
    label: displayNames[name] ?? titleCase(name),
    source: "OpenCode" as const,
    palette,
  })),
];

const themeByName = new Map(themes.map((theme) => [theme.name, theme]));

export function findTheme(name: string | undefined): ThemeDefinition | undefined {
  return name ? themeByName.get(name) : undefined;
}

export function resolveThemeName(
  requested: string | undefined,
  persisted: string | undefined,
): string {
  if (requested) {
    if (!findTheme(requested)) throw new Error(`unknown TUI theme ${requested}`);
    return requested;
  }
  return findTheme(persisted)?.name ?? defaultThemeName;
}

export function themeConfigPath(environment = process.env): string {
  const configHome = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(configHome, "rudder", "tui.json");
}

function legacyThemeConfigPath(environment = process.env): string {
  const configHome = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "codex-rudder", "tui.json");
}

export async function readPersistedTheme(
  configFile?: string,
): Promise<string | undefined> {
  return (await readTUIConfig(configFile)).theme;
}

export async function readTUIConfig(configFile?: string): Promise<TUIConfig> {
  const selectedPath = configFile ?? themeConfigPath();
  try {
    const parsed = JSON.parse(await readFile(selectedPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const theme = Reflect.get(parsed, "theme");
    const diffTreeWidth = Reflect.get(parsed, "diffTreeWidth");
    return {
      ...(typeof theme === "string" ? { theme } : {}),
      ...(typeof diffTreeWidth === "number" && Number.isFinite(diffTreeWidth)
        ? { diffTreeWidth }
        : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && configFile === undefined)
      return readTUIConfig(legacyThemeConfigPath());
    if (code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function persistTheme(
  name: string,
  configFile = themeConfigPath(),
): Promise<void> {
  if (!findTheme(name)) throw new Error(`unknown TUI theme ${name}`);
  await persistTUIConfig({ ...(await readTUIConfig(configFile)), theme: name }, configFile);
}

export async function persistTUIConfig(
  config: TUIConfig,
  configFile = themeConfigPath(),
): Promise<void> {
  const directory = dirname(configFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${configFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, configFile);
}
