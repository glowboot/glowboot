/** Build a filesystem-safe filename stem from a cart title. */
export function sanitize(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9 _.-]/g, "_")
      .trim()
      .replace(/\s+/g, "_") || "gameboy"
  );
}
