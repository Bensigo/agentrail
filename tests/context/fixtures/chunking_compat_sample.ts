// Stable fixture for chunking compatibility snapshot test (M018).
// Do not modify this file — it is locked as a reference for chunk-boundary regression detection.

function parseConfig(path: string): string {
    return path;
}

function validate(config: string): boolean {
    if (!config) { throw new Error("empty config"); }
    return true;
}

interface Loader {
    load(path: string): string;
}

class ConfigLoader implements Loader {
    load(path: string): string {
        return parseConfig(path);
    }
}
