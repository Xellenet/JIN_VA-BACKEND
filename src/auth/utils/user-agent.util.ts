/**
 * A short, human description of a browser user agent for the "New sign-in"
 * email — "Chrome on Windows", "Safari on iPhone". Approximate on purpose: no
 * version numbers, nothing that fingerprints. Unknown or missing → "an
 * unknown device".
 */
export function describeUserAgent(
  userAgent: string | null | undefined,
): string {
  if (!userAgent || typeof userAgent !== 'string') return 'an unknown device';
  const ua = userAgent.slice(0, 512);

  let browser: string | undefined;
  if (/\bEdg(e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/\bOPR\/|\bOpera\b/.test(ua)) browser = 'Opera';
  else if (/\bSamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/\bFirefox\/|\bFxiOS\//.test(ua)) browser = 'Firefox';
  else if (/\bChrome\/|\bCriOS\//.test(ua)) browser = 'Chrome';
  else if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) browser = 'Safari';

  let os: string | undefined;
  if (/\biPhone\b/.test(ua)) os = 'iPhone';
  else if (/\biPad\b/.test(ua)) os = 'iPad';
  else if (/\bAndroid\b/.test(ua)) os = 'Android';
  else if (/\bWindows\b/.test(ua)) os = 'Windows';
  else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) os = 'macOS';
  else if (/\bCrOS\b/.test(ua)) os = 'ChromeOS';
  else if (/\bLinux\b/.test(ua)) os = 'Linux';

  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `a browser on ${os}`;
  return 'an unknown device';
}
