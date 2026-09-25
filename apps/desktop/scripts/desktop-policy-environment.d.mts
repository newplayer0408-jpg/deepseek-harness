/** Required deployment-selected metadata for mandatory-update policy requests. */
export interface DesktopPolicyEnvironment {
  origin: string
  allowedPageOrigins: string[]
  allowedAuthOrigins?: string[]
  authentication: 'anonymous' | 'feishu-test'
  [key: string]: unknown
}

/**
 * Resolve policy settings before artifact preparation or signing.
 * @param environment File-owned release settings; only the selected origin is required.
 * @param variant Product variant resolved by resolveDesktopVariant.
 * @returns Policy metadata with deployment-selected origin and authentication, or undefined for a variant with no policy service.
 */
export function resolveDesktopPolicyEnvironment(
  environment: NodeJS.ProcessEnv,
  variant: string,
): DesktopPolicyEnvironment | undefined
