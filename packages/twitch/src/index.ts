/* ═══════════════════════════════════════════════════════════════════════
   ANGEL per Twitch — libreria

   Tutto quello che serve a moderare una chat Twitch, senza dipendere né dal
   database né da Discord. La divisione è la stessa di `@angel/scanner`: qui
   dentro non si scrive niente da nessuna parte, e ogni regola si può provare
   con una stringa e un oggetto.
   ═══════════════════════════════════════════════════════════════════════ */

export * from './bucket.js';
export * from './helix.js';
export * from './eventsub.js';
export * from './moderazione/segnali.js';
export * from './moderazione/motore.js';
