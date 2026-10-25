export const COLORS = ['#a7f36b', '#77cfff', '#ffb878', '#d4a5ff'];
export const CREW_SYMBOLS = ['✳', '✧', '◎', '✦'];
export const DOCKS = [
  { x: 0, y: -315, color: '#a7f36b', name: '芽绿', symbol: '△' },
  { x: 273, y: 158, color: '#77cfff', name: '冰蓝', symbol: '◇' },
  { x: -273, y: 158, color: '#ffb878', name: '琥珀', symbol: '○' },
];
export const CONFIG = {
  radius: 390, speed: 155, duration: 150, target: 18, minPlayers: 2, maxPlayers: 4,
  reservationMs: 90_000, tickRate: 30, supplyInterval: 9, supplyBatchSize: 3,
  maxLooseCores: 6, pulsePeriod: 13, pulseWarningAt: 7, pulseStartAt: 9,
  dashCooldown: 3.2, pickupRadius: 53, deliveryRadius: 70,
  comboWindow: 8, maxCombo: 5, relayBonus: 4,
  hostIdleMs: 30_000, joinShield: 1.2,
};
if (CONFIG.maxPlayers !== COLORS.length || CONFIG.maxPlayers !== CREW_SYMBOLS.length) {
  throw new Error('Player count must match crew colors and symbols.');
}
