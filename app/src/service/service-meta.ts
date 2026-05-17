/**
 * Static service metadata. Lives in its own module so the install CLI
 * doesn't need to load service-host (and therefore koffi + advapi32) just
 * to read three strings.
 */

export const SERVICE_NAME = 'TitanXTService';
export const SERVICE_DISPLAY = 'Titan-XT Remote Input Service';
export const SERVICE_DESCRIPTION =
  'Provides elevated input simulation for Titan-XT so remote control still works against UAC-elevated apps.';
