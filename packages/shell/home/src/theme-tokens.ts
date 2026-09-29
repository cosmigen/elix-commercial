/**
 * Compatibility exports for Home theme consumers.
 *
 * Phase 16B promotes the token authority to @deepseek-ai/dsh-ui-foundation;
 * Home retains this module so existing imports and renderer code remain stable.
 *
 * @module @deepseek-ai/dsh-home/theme-tokens
 */

export {
  DEFAULT_THEME_TOKENS,
  generateThemeTokensCss,
  THEME_COMPONENT_TOKENS,
  THEME_PRIMITIVE_TOKENS,
  THEME_SEMANTIC_DARK_TOKENS,
  THEME_SEMANTIC_HIGH_CONTRAST_TOKENS,
  THEME_SEMANTIC_LIGHT_TOKENS,
  THEME_SEMANTIC_TOKENS,
} from '@deepseek-ai/dsh-ui-foundation'
