// madge ships no types. We call exactly two things on it, so a local
// declaration is cheaper than adding @types/madge as a dependency to vet.
declare module 'madge' {
  interface MadgeInstance {
    obj(): Record<string, string[]>;
  }
  interface MadgeOptions {
    fileExtensions?: string[];
    excludeRegExp?: RegExp[];
  }
  export default function madge(path: string, options?: MadgeOptions): Promise<MadgeInstance>;
}
