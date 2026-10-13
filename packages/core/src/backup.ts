/** Fréquences proposées pour la sauvegarde automatique, en minutes (0 : une fois par jour). */
export const BACKUP_FREQUENCIES: [number, string][] = [
  [0, 'Une fois par jour'],
  [15, 'Toutes les 15 minutes'],
  [30, 'Toutes les 30 minutes'],
  [60, 'Toutes les heures'],
  [120, 'Toutes les 2 heures'],
  [180, 'Toutes les 3 heures'],
  [240, 'Toutes les 4 heures'],
  [360, 'Toutes les 6 heures'],
  [720, 'Toutes les 12 heures'],
];
