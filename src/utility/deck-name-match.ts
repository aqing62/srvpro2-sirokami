export function deckNameMatch(deckName: string, playerName: string) {
  if (
    deckName === playerName ||
    deckName === `${playerName}.ydk` ||
    deckName === `${playerName}.ydk.ydk`
  ) {
    return true;
  }
  const parsedDeckName = deckName.match(
    /^([^\+ \uff0b]+)[\+ \uff0b](.+?)(\.ydk){0,2}$/,
  );
  return !!(
    parsedDeckName &&
    (playerName === parsedDeckName[1] || playerName === parsedDeckName[2])
  );
}
