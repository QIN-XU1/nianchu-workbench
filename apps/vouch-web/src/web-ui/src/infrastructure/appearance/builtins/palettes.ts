
export { openBitFunDarkPalette } from './dark';
export { openBitFunLightPalette } from './light';
export { openBitFunMonochromePalette } from './monochrome';
export { openBitFunMidnightPalette } from './midnight';
export { openBitFunChinaStylePalette } from './chinaStyle';
export { openBitFunChinaNightPalette } from './chinaNight';
export { openBitFunCyberPalette } from './cyber';
export { openBitFunSlatePalette } from './slate';
export { openBitFunTokyoNightPalette } from './tokyoNight';
export { claudeLightPalette } from './claudeLight';
export { claudeDarkPalette } from './claudeDark';

import { openBitFunDarkPalette } from './dark';
import { openBitFunLightPalette } from './light';
import { openBitFunMonochromePalette } from './monochrome';
import { openBitFunMidnightPalette } from './midnight';
import { openBitFunChinaStylePalette } from './chinaStyle';
import { openBitFunChinaNightPalette } from './chinaNight';
import { openBitFunCyberPalette } from './cyber';
import { openBitFunSlatePalette } from './slate';
import { openBitFunTokyoNightPalette } from './tokyoNight';
import { claudeLightPalette } from './claudeLight';
import { claudeDarkPalette } from './claudeDark';
import type { AppearancePalette, AppearancePaletteId } from './AppearancePalette';

export const DEFAULT_LIGHT_APPEARANCE_ID: AppearancePaletteId = 'openbitfun-light';
export const DEFAULT_DARK_APPEARANCE_ID: AppearancePaletteId = 'openbitfun-dark';

export const builtinAppearancePalettes: readonly AppearancePalette[] = Object.freeze([
  openBitFunLightPalette,
  claudeLightPalette,
  openBitFunMonochromePalette,
  openBitFunSlatePalette,
  openBitFunDarkPalette,
  claudeDarkPalette,
  openBitFunMidnightPalette,
  openBitFunChinaStylePalette,
  openBitFunChinaNightPalette,
  openBitFunCyberPalette,
  openBitFunTokyoNightPalette,
]);
