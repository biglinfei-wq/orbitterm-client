type CompatNavigator = Navigator & {
  userAgentData?: {
    mobile?: boolean;
    platform?: string;
  };
};

const readNavigator = (): CompatNavigator | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }
  return navigator as CompatNavigator;
};

export const detectMobileFormFactor = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  const nav = readNavigator();
  const userAgent = (nav?.userAgent || '').toLowerCase();
  const platform = (nav?.userAgentData?.platform || nav?.platform || '').toLowerCase();
  const byUa = /(android|iphone|ipad|ipod|mobile|harmonyos)/i.test(userAgent);
  const byPlatform = /(android|iphone|ipad|ipod|ios|harmony)/i.test(platform);
  const byWidth = window.innerWidth <= 980;
  const byCoarsePointer = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  const byTouchCapability = (nav?.maxTouchPoints ?? 0) > 1 && window.innerWidth <= 1366;
  const byUaData = nav?.userAgentData?.mobile === true;
  return byUa || byPlatform || byWidth || byCoarsePointer || byTouchCapability || byUaData;
};

export const isAndroidRuntime = (): boolean => {
  const nav = readNavigator();
  const userAgent = (nav?.userAgent || '').toLowerCase();
  const platform = (nav?.userAgentData?.platform || nav?.platform || '').toLowerCase();
  return userAgent.includes('android') || platform.includes('android');
};
