export type RandomDuelPunishReason = 'AFK' | 'ABUSE' | 'FLEE' | 'ZOMBIE';

export const punishReasonToI18nKey = (reason: RandomDuelPunishReason) => {
  if (reason === 'AFK') {
    return 'random_ban_reason_AFK';
  }
  if (reason === 'ABUSE') {
    return 'random_ban_reason_abuse';
  }
  if (reason === 'FLEE') {
    return 'random_ban_reason_flee';
  }
  return 'random_ban_reason_zombie';
};

export const renderReasonText = (reasons: RandomDuelPunishReason[]) => {
  const entries = [...new Set(reasons)].map(
    (reason) => `#{${punishReasonToI18nKey(reason)}}`,
  );
  if (!entries.length) {
    return `#{${punishReasonToI18nKey('ABUSE')}}`;
  }
  return entries.join('#{random_ban_reason_separator}');
};

export const formatRemainText = (expireAt: number) => {
  const remainMs = Math.max(0, expireAt - Date.now());
  const remainMinutes = Math.max(1, Math.ceil(remainMs / 60_000));
  if (remainMinutes >= 60) {
    const hours = Math.floor(remainMinutes / 60);
    const minutes = remainMinutes % 60;
    if (minutes <= 0) {
      return `${hours}h`;
    }
    return `${hours}h ${minutes}m`;
  }
  return `${remainMinutes}m`;
};
