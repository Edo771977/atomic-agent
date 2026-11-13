/** Canonical-name admission shared by batch shaping and dispatch. */
export function toolFilterAdmits(
  name: string,
  filter: ((name: string) => boolean) | undefined,
): boolean {
  return name === "reply" || name === "finish" || filter?.(name) !== false;
}
