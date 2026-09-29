// Horodatages renvoyés par l'API : ISO 8601 avec fuseau (services récents) ou `CURRENT_TIMESTAMP` SQLite
// (`YYYY-MM-DD HH:MM:SS`, en UTC mais sans fuseau). `new Date()` lirait ce dernier en heure locale (décalage de 1 à 2 h en France) :
// il est normalisé en ISO UTC avant lecture. Toute autre valeur est renvoyée telle quelle.
const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export const normalizeServerTimestamp = (value: string): string => SQLITE_UTC_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value;
