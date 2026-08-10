import { describe, expect, it } from 'vitest';
import {
  analyzeUrl,
  containsCryptoAddress,
  deobfuscate,
  detectImpersonation,
  extractUrls,
  isCdnExecutable,
  isDiscordRemoteAuth,
  isIpGrabber,
  parseOAuthLink,
} from '../url.js';

const options = {
  protectedDomains: ['discord.com', 'discord.gg', 'steamcommunity.com'],
  blockedDomains: [],
  allowedDomains: [],
  ipGrabberDomains: [],
  flagOAuth: true,
  allowedOAuthAppIds: [],
  blockCdnExecutables: true,
};

describe('estrazione URL', () => {
  it('trova i link normali', () => {
    const urls = extractUrls('guarda qui https://example.com/pagina e poi dimmi');
    expect(urls).toHaveLength(1);
    expect(urls[0]?.host).toBe('example.com');
  });

  it('riconosce i link scritti senza schema', () => {
    const urls = extractUrls('vai su example.com/promo');
    expect(urls[0]?.host).toBe('example.com');
  });

  it('smaschera hxxp e i punti fra parentesi', () => {
    const { text, changed } = deobfuscate('hxxps://malware[.]example[.]com/payload');
    expect(changed).toBe(true);
    expect(text).toContain('https://malware.example.com/payload');
  });

  it('marca come offuscato un link scritto per eludere i filtri', () => {
    const urls = extractUrls('scarica da hxxps://cattivo[.]com/file');
    expect(urls[0]?.wasObfuscated).toBe(true);
    expect(urls[0]?.host).toBe('cattivo.com');
  });

  it('rimuove la punteggiatura incollata alla fine', () => {
    const urls = extractUrls('il sito è https://example.com/pagina.');
    expect(urls[0]?.url).not.toMatch(/\.$/);
  });

  it('non produce falsi positivi su testo senza link', () => {
    expect(extractUrls('ciao come stai, tutto bene?')).toHaveLength(0);
  });
});

describe('Remote Auth di Discord', () => {
  // È il caso più grave che lo scanner debba riconoscere: chi inquadra questo
  // QR consegna il token del proprio account senza alcun avviso.
  it('riconosce il link di login via QR', () => {
    expect(isDiscordRemoteAuth('https://discord.com/ra/abc123def456')).toBe(true);
    expect(isDiscordRemoteAuth('https://discord.com/ra/')).toBe(true);
  });

  it('non confonde altri percorsi di discord.com', () => {
    expect(isDiscordRemoteAuth('https://discord.com/channels/123/456')).toBe(false);
    expect(isDiscordRemoteAuth('https://discord.com/invite/abcdef')).toBe(false);
  });

  it('non si fa ingannare da un dominio simile', () => {
    expect(isDiscordRemoteAuth('https://discord.com.evil.tld/ra/token')).toBe(false);
  });

  it('assegna il punteggio massimo e si ferma lì', () => {
    const [entry] = extractUrls('https://discord.com/ra/xyz');
    const findings = analyzeUrl(entry!, options);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('URL_DISCORD_REMOTE_AUTH');
    expect(findings[0]?.score).toBe(100);
  });
});

describe('imitazione dei domini', () => {
  it('riconosce gli omoglifi cirillici', () => {
    // "discоrd.com" con la o cirillica
    const result = detectImpersonation('discоrd.com', options.protectedDomains);
    expect(result?.impersonates).toBe('discord.com');
    expect(result?.kind).toBe('HOMOGLYPH');
  });

  it('riconosce il typosquatting', () => {
    const result = detectImpersonation('discrod.com', options.protectedDomains);
    expect(result?.impersonates).toBe('discord.com');
    expect(result?.kind).toBe('TYPOSQUAT');
  });

  it('lascia passare il dominio autentico e i suoi sottodomini', () => {
    expect(detectImpersonation('discord.com', options.protectedDomains)).toBeNull();
    expect(detectImpersonation('cdn.discord.com', options.protectedDomains)).toBeNull();
  });

  it('non segnala domini legittimi che non somigliano a nulla', () => {
    expect(detectImpersonation('github.com', options.protectedDomains)).toBeNull();
    expect(detectImpersonation('example.org', options.protectedDomains)).toBeNull();
  });
});

describe('CDN Discord e file eseguibili', () => {
  it('segnala gli eseguibili ospitati sulla CDN', () => {
    expect(isCdnExecutable('https://cdn.discordapp.com/attachments/1/2/setup.exe')).toBe(true);
    expect(isCdnExecutable('https://cdn.discordapp.com/attachments/1/2/cheat.scr?ex=1')).toBe(true);
  });

  it('lascia passare le immagini', () => {
    expect(isCdnExecutable('https://cdn.discordapp.com/attachments/1/2/foto.png')).toBe(false);
  });
});

describe('link OAuth2', () => {
  it('estrae ID applicazione e scope', () => {
    const parsed = parseOAuthLink(
      'https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20identify&permissions=8',
    );
    expect(parsed?.clientId).toBe('123456789012345678');
    expect(parsed?.scopes).toContain('bot');
  });

  it('segnala le app non approvate', () => {
    const [entry] = extractUrls(
      'https://discord.com/oauth2/authorize?client_id=999&scope=bot+guilds.join',
    );
    const findings = analyzeUrl(entry!, options);
    expect(findings.some((finding) => finding.code === 'URL_OAUTH_APP')).toBe(true);
  });
});

describe('raccolta IP e wallet', () => {
  it('riconosce i domini grabber noti', () => {
    expect(isIpGrabber('grabify.link')).toBe(true);
    expect(isIpGrabber('www.iplogger.org')).toBe(true);
    expect(isIpGrabber('example.com')).toBe(false);
  });

  it('riconosce gli indirizzi di wallet nel testo', () => {
    expect(containsCryptoAddress('manda a 0x71C7656EC7ab88b098defB751B7401B5f6d8976F')).toBe(true);
    expect(containsCryptoAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(containsCryptoAddress('nessun indirizzo qui')).toBe(false);
  });
});
