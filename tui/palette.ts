// Active theme palette shared by every renderer. ESM live bindings let
// modules import `palette` and see the new theme after setPalette().
import { blendHex } from "./core";
import { defaultThemeName, findTheme, type ThemePalette } from "./themes";

export let palette: ThemePalette = findTheme(defaultThemeName)!.palette;

export interface DiffTints {
  additionBg: string;
  deletionBg: string;
  additionGutterBg: string;
  deletionGutterBg: string;
  hunkBg: string;
}

export function diffTintsFor(theme: ThemePalette): DiffTints {
  return {
    additionBg: blendHex(theme.background, theme.success, 0.14),
    deletionBg: blendHex(theme.background, theme.danger, 0.14),
    additionGutterBg: blendHex(theme.background, theme.success, 0.24),
    deletionGutterBg: blendHex(theme.background, theme.danger, 0.24),
    hunkBg: blendHex(theme.background, theme.accent, 0.08),
  };
}

export let diffTints: DiffTints = diffTintsFor(palette);

export function setPalette(next: ThemePalette): void {
  palette = next;
  diffTints = diffTintsFor(next);
}
