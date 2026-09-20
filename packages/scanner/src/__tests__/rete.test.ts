import { describe, expect, it } from 'vitest';
import { destinazioneAmmessa, indirizzoInterno } from '../rete.js';

/*
 * Lo scanner segue i redirect dei link scritti in chat. Girata: chiunque può
 * far fare al bot una richiesta HTTP verso un indirizzo che scrive lui —
 * dentro Docker, il pannello, il database, gli altri container; in cloud,
 * l'indirizzo dei metadati dell'istanza.
 *
 * I casi qui sotto sono gli indirizzi con cui si prova.
 */

describe('indirizzi interni', () => {
  const interni = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.17.0.2', // la rete di Docker
    '172.31.255.255',
    '192.168.1.77',
    '169.254.169.254', // metadati in cloud
    '100.64.0.1', // Tailscale
    '100.127.26.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1', // loopback mascherato da IPv6
    '224.0.0.1',
  ];
  for (const ip of interni) {
    it(`blocca ${ip}`, () => {
      expect(indirizzoInterno(ip)).toBe(true);
    });
  }

  // La controprova: se bloccasse tutto, lo scanner smetterebbe di funzionare
  // senza che nessun test lo dica.
  const pubblici = ['1.1.1.1', '8.8.8.8', '172.32.0.1', '99.63.255.1', '2606:4700::1111'];
  for (const ip of pubblici) {
    it(`lascia passare ${ip}`, () => {
      expect(indirizzoInterno(ip)).toBe(false);
    });
  }
});

describe('destinazioni ammesse', () => {
  it('rifiuta gli indirizzi interni scritti per numero', async () => {
    expect((await destinazioneAmmessa('http://127.0.0.1:8080/api/version')).ok).toBe(false);
    expect((await destinazioneAmmessa('http://169.254.169.254/latest/meta-data/')).ok).toBe(false);
    expect((await destinazioneAmmessa('http://[::1]/')).ok).toBe(false);
  });

  it('rifiuta gli schemi che non sono web', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://esempio.it/x', 'gopher://esempio.it']) {
      expect((await destinazioneAmmessa(url)).ok, url).toBe(false);
    }
  });

  it('rifiuta le porte dei servizi interni', async () => {
    // Postgres e Redis stanno dietro nomi che si risolvono nella rete di
    // Docker, ma la porta da sola basta a fermare il tentativo.
    expect((await destinazioneAmmessa('http://1.1.1.1:5432/')).ok).toBe(false);
    expect((await destinazioneAmmessa('http://1.1.1.1:6379/')).ok).toBe(false);
  });

  it('lascia passare un indirizzo pubblico sulle porte del web', async () => {
    expect((await destinazioneAmmessa('https://1.1.1.1/qualcosa')).ok).toBe(true);
    expect((await destinazioneAmmessa('http://8.8.8.8:8080/')).ok).toBe(true);
  });

  it('rifiuta un indirizzo che non si legge', async () => {
    expect((await destinazioneAmmessa('non-un-indirizzo')).ok).toBe(false);
  });
});
