'use strict';

const REPO = 'denmie/stellenradar';
const NEU_TAGE = 7;
// Beim Zurückkehren in die App neu laden, aber nicht bei jedem kurzen Wechsel.
const MINDESTABSTAND_MS = 30_000;

const el = (id) => document.getElementById(id);
const speicher = {
  get token() { return localStorage.getItem('token'); },
  set token(wert) { wert ? localStorage.setItem('token', wert) : localStorage.removeItem('token'); },
};

let stellen = [];
let sortierung = JSON.parse(localStorage.getItem('sortierung') ?? 'null') ?? { spalte: 'datum', absteigend: true };
let zuletztGeladen = 0;
let offenId = null;
let suchtext = '';
let letzterStand = [null, ''];
// Bewerbungen bleiben nur auf diesem Gerät: { Stellennummer: Datum }.
let beworben = {};
try { beworben = JSON.parse(localStorage.getItem('beworben') ?? '{}') ?? {}; } catch { beworben = {}; }

async function holeApi(pfad, accept) {
  const antwort = await fetch(`https://api.github.com/repos/${REPO}/${pfad}`, {
    headers: { Authorization: `Bearer ${speicher.token}`, Accept: accept },
    cache: 'no-store',
  });
  if (antwort.status === 401 || antwort.status === 403 || antwort.status === 404) {
    const fehler = new Error('Zugang abgelehnt');
    fehler.zugang = true;
    throw fehler;
  }
  if (!antwort.ok) throw new Error(`GitHub antwortet mit HTTP ${antwort.status}`);
  return antwort.json();
}

function offeneStellen(state) {
  const nachId = new Map();
  for (const suche of Object.values(state.suchen ?? {})) {
    for (const [id, job] of Object.entries(suche.gesehen ?? {})) {
      if (job.passt && !job.weg) nachId.set(id, { ...job, id });
    }
  }
  return [...nachId.values()];
}

/** Kürzt Firmennamen um Rechtsform und den Namensteil, den alle gemeinsam haben. */
function kurzeFirmen(jobs) {
  const namen = [...new Set(jobs.map((job) => job.firma ?? ''))];
  const woerter = namen.map((name) => name.replace(/\s+(GmbH|AG|SE|KG)$/, '').split(' '));
  let gemeinsam = 0;
  if (namen.length > 1) {
    while (
      woerter.every((w) => w.length > gemeinsam + 1 && w[gemeinsam] === woerter[0][gemeinsam])
    ) gemeinsam += 1;
  }
  const kurz = new Map(namen.map((name, i) => [name, woerter[i].slice(gemeinsam).join(' ')]));
  return (firma) => kurz.get(firma ?? '') ?? '';
}

const datumKurz = (iso) => {
  if (!iso) return '–';
  const [jahr, monat, tag] = iso.split('-');
  return `${tag}.${monat}.${jahr === String(new Date().getFullYear()) ? '' : jahr.slice(2)}`;
};

function istNeu(job) {
  if (!job.ausgeschrieben) return false;
  const [jahr, monat, tag] = job.ausgeschrieben.split('-').map(Number);
  const heute = new Date();
  const tage = (new Date(heute.getFullYear(), heute.getMonth(), heute.getDate()) - new Date(jahr, monat - 1, tag)) / 86_400_000;
  return tage <= NEU_TAGE;
}

/** Öffnet die deutsche Fassung der Anzeige. Adressen, die schon eine Sprache tragen, bleiben unverändert. */
function deutscherLink(url) {
  const adresse = new URL(url);
  if (!/^\/[a-z]{2}-[A-Z]{2}\//.test(adresse.pathname)) adresse.pathname = `/de-DE${adresse.pathname}`;
  return adresse.href;
}

const ohneKuerzel = (titel) => titel.replace(/\s*\([mfwd]\s*\/[^)]*\)/gi, '').replace(/\s+/g, ' ').trim();

function vergleiche(a, b) {
  const nachTitel = ohneKuerzel(a.titel).localeCompare(ohneKuerzel(b.titel), 'de');
  if (sortierung.spalte === 'titel') return sortierung.absteigend ? -nachTitel : nachTitel;
  const nachDatum = (a.ausgeschrieben ?? '').localeCompare(b.ausgeschrieben ?? '');
  return (sortierung.absteigend ? -nachDatum : nachDatum) || nachTitel;
}

const schluessel = (job) => job.id ?? job.url;
const hatBeworben = (job) => Boolean(beworben[schluessel(job)]);

/** Klappt das Aktionsfeld einer Stelle auf oder zu. Es ist immer höchstens eines offen. */
function klappe(id) {
  offenId = offenId === id ? null : id;
  for (const tr of document.querySelectorAll('tr.stelle')) {
    const auf = tr.dataset.id === offenId;
    tr.classList.toggle('auf', auf);
    tr.querySelector('.titel').setAttribute('aria-expanded', String(auf));
    tr.nextElementSibling.classList.toggle('auf', auf);
    tr.nextElementSibling.inert = !auf;
  }
}

function markiere(job) {
  const id = schluessel(job);
  if (beworben[id]) delete beworben[id];
  else beworben[id] = new Date().toISOString().slice(0, 10);
  localStorage.setItem('beworben', JSON.stringify(beworben));
  zeichne();
  statuszeile(...letzterStand);
}

function zeilen(job, firmaKurz) {
  const id = schluessel(job);
  const istBeworben = hatBeworben(job);
  const neu = !istBeworben && istNeu(job);
  const auf = id === offenId;

  const tr = document.createElement('tr');
  tr.className = ['stelle', istBeworben ? 'beworben' : neu ? 'neu' : '', auf ? 'auf' : ''].filter(Boolean).join(' ');
  tr.dataset.id = id;
  tr.addEventListener('click', () => klappe(id));

  const titel = document.createElement('td');
  if (istBeworben || neu) {
    const marke = document.createElement('span');
    marke.className = 'marke';
    marke.textContent = istBeworben ? 'BEWORBEN' : 'NEU';
    titel.append(marke);
  }
  // Kein <button>: Der Titel soll wie Fließtext hinter der Marke umbrechen.
  const name = document.createElement('span');
  name.className = 'titel';
  name.textContent = ohneKuerzel(job.titel);
  name.setAttribute('role', 'button');
  name.tabIndex = 0;
  name.setAttribute('aria-expanded', String(auf));
  name.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    klappe(id);
  });
  titel.append(name);
  if (job.ort) {
    const ort = document.createElement('small');
    ort.textContent = job.ort;
    titel.append(ort);
  }

  const firma = document.createElement('td');
  firma.className = 'firma';
  firma.textContent = firmaKurz(job.firma);

  const datum = document.createElement('td');
  datum.className = 'datum';
  datum.textContent = datumKurz(job.ausgeschrieben);

  tr.append(titel, firma, datum);

  const aktionen = document.createElement('tr');
  aktionen.className = auf ? 'aktionen auf' : 'aktionen';
  aktionen.inert = !auf;
  const zelle = document.createElement('td');
  zelle.colSpan = 3;
  const fach = document.createElement('div');
  fach.className = 'fach';
  const inhalt = document.createElement('div');
  inhalt.className = 'inhalt';
  const leiste = document.createElement('div');
  leiste.className = 'leiste';

  // Nur echte Webadressen verlinken, die Daten kommen von außen.
  if (/^https:\/\//.test(job.url ?? '')) {
    const oeffnen = document.createElement('a');
    oeffnen.className = 'knopf haupt';
    oeffnen.textContent = 'Öffnen';
    oeffnen.href = deutscherLink(job.url);
    oeffnen.target = '_blank';
    oeffnen.rel = 'noopener noreferrer';
    leiste.append(oeffnen);
  }
  const merken = document.createElement('button');
  merken.type = 'button';
  merken.className = 'knopf';
  merken.textContent = istBeworben ? 'Markierung entfernen' : 'Als beworben markieren';
  merken.addEventListener('click', () => markiere(job));
  leiste.append(merken);
  inhalt.append(leiste);
  if (istBeworben) {
    const notiz = document.createElement('p');
    notiz.className = 'notiz';
    notiz.textContent = `Beworben am ${datumKurz(beworben[id])}`;
    inhalt.append(notiz);
  }
  fach.append(inhalt);
  zelle.append(fach);
  aktionen.append(zelle);

  return [tr, aktionen];
}

function zeichne() {
  const firmaKurz = kurzeFirmen(stellen);
  const gesucht = suchtext.toLocaleLowerCase('de');
  const sortiert = stellen
    .filter((job) => ohneKuerzel(job.titel).toLocaleLowerCase('de').includes(gesucht))
    .sort(vergleiche);
  const inhalt = sortiert.flatMap((job) => zeilen(job, firmaKurz));
  if (inhalt.length === 0 && stellen.length > 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'leer';
    td.textContent = `Kein Titel enthält „${suchtext}“.`;
    tr.append(td);
    inhalt.push(tr);
  }
  document.querySelector('#liste tbody').replaceChildren(...inhalt);
  el('suche').hidden = false;
  for (const th of document.querySelectorAll('th[data-spalte]')) {
    const aktiv = th.dataset.spalte === sortierung.spalte;
    th.querySelector('span').textContent = aktiv ? (sortierung.absteigend ? '▼' : '▲') : '';
    if (aktiv) th.setAttribute('aria-sort', sortierung.absteigend ? 'descending' : 'ascending');
    else th.removeAttribute('aria-sort');
  }
  el('liste').hidden = false;
  el('fuss').hidden = false;
  el('zugang').hidden = true;
}

const zeitpunkt = (iso) =>
  new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function statuszeile(geaendert, zusatz = '') {
  letzterStand = [geaendert, zusatz];
  const anzahlBeworben = stellen.filter(hatBeworben).length;
  const neu = stellen.filter((job) => !hatBeworben(job) && istNeu(job)).length;
  const teile = [`${stellen.length} offen`, `${neu} neu`];
  if (anzahlBeworben) teile.push(`${anzahlBeworben} beworben`);
  if (geaendert) teile.push(`Liste geändert ${zeitpunkt(geaendert)}`);
  el('status').textContent = teile.join(' · ') + zusatz;
}

function zeigeZugang(hinweis) {
  if (hinweis) el('zugang-hinweis').textContent = hinweis;
  el('zugang').hidden = false;
  el('suche').hidden = true;
  el('liste').hidden = true;
  el('fuss').hidden = true;
  el('status').textContent = '';
}

async function lade() {
  if (!speicher.token) return zeigeZugang();
  zuletztGeladen = Date.now();
  try {
    const [state, commits] = await Promise.all([
      holeApi('contents/state.json', 'application/vnd.github.raw+json'),
      holeApi('commits?path=state.json&per_page=1', 'application/vnd.github+json'),
    ]);
    stellen = offeneStellen(state);
    const geaendert = commits[0]?.commit?.committer?.date ?? null;
    localStorage.setItem('kopie', JSON.stringify({ stellen, geaendert }));
    zeichne();
    statuszeile(geaendert);
  } catch (fehler) {
    if (fehler.zugang) {
      speicher.token = null;
      localStorage.removeItem('kopie');
      stellen = [];
      return zeigeZugang('GitHub hat den Schlüssel abgelehnt. Er ist vielleicht abgelaufen oder hat nicht die richtigen Rechte. Bitte neu eintragen.');
    }
    const kopie = JSON.parse(localStorage.getItem('kopie') ?? 'null');
    if (kopie) {
      stellen = kopie.stellen;
      zeichne();
      statuszeile(kopie.geaendert, ' · offline, letzter Stand');
    } else {
      el('status').textContent = `Laden fehlgeschlagen: ${fehler.message}`;
    }
  }
}

el('speichern').addEventListener('click', () => {
  const wert = el('token').value.trim();
  if (!wert) return;
  speicher.token = wert;
  el('token').value = '';
  el('status').textContent = 'Lade …';
  lade();
});

el('suche').addEventListener('input', (e) => {
  suchtext = e.target.value.trim();
  zeichne();
});

el('abmelden').addEventListener('click', () => {
  speicher.token = null;
  localStorage.removeItem('kopie');
  stellen = [];
  zeigeZugang();
});

for (const th of document.querySelectorAll('th[data-spalte]')) {
  th.querySelector('button').addEventListener('click', () => {
    const spalte = th.dataset.spalte;
    sortierung = sortierung.spalte === spalte
      ? { spalte, absteigend: !sortierung.absteigend }
      : { spalte, absteigend: spalte === 'datum' };
    localStorage.setItem('sortierung', JSON.stringify(sortierung));
    zeichne();
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - zuletztGeladen > MINDESTABSTAND_MS) lade();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
lade();
