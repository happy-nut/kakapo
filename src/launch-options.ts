// What the launch asked for and only the first window may have. makeOptions() spreads one window's options
// into the next, so every one of these has to be blanked there and assigned to the first window beside
// createWindow(). Blanking one without assigning it is silent: the argument parses, the option exists, and
// nothing happens. The two lists were written by hand in two places; this is the list.
export const LAUNCH_ONLY_OPTIONS = ["openPath", "pullRequest"] as const;

export type LaunchOnlyOption = (typeof LAUNCH_ONLY_OPTIONS)[number];

type WithLaunchOnly = { [K in LaunchOnlyOption]?: string };

export function withoutLaunchOnly<T extends WithLaunchOnly>(options: T): T {
  const blanked = { ...options };
  for (const key of LAUNCH_ONLY_OPTIONS) blanked[key] = undefined;
  return blanked;
}

export function applyLaunchOnly<T extends WithLaunchOnly>(target: T, launch: WithLaunchOnly): void {
  for (const key of LAUNCH_ONLY_OPTIONS) target[key] = launch[key] as T[LaunchOnlyOption];
}
