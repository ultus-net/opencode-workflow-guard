/** Types for `config-writer.mjs`, the testable half of the `setup` command. */

export declare const PACKAGE_NAME: string;
export declare function pluginKeyFor(config: Record<string, unknown>, explicitMajor?: number): "plugin" | "plugins";
export declare function matchesPackageSpec(entry: unknown, spec: string): boolean;
export declare function preparePluginUpdate(
	path: string,
	schema: string,
	spec: string,
	legacySpec?: string,
	explicitMajor?: number,
): string | undefined;
