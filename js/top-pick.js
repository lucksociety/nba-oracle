// The model's most likely winner as a plain pick, shown when no value bet qualifies.
// `market` is the no-vig price of that side. A pick is not a value bet.
export function topPick(name, p, market) {
  if (!(p >= 0.55)) return `🎯 Top pick: none, too close to call (${name} ${(p * 100).toFixed(0)}%)`;
  const price = !Number.isFinite(market) ? 'no price available'
    : `price about ${(market * 100).toFixed(0)}¢` + (p - market >= 0.02 ? ' · model rates it above the price' : p - market <= -0.02 ? ' · price is above the model’s number' : ' · in line with the price');
  return `🎯 **Top pick: ${name} to win** · model ${(p * 100).toFixed(0)}% · ${price}\n_A pick is the model’s most likely winner, not a value bet._`;
}
