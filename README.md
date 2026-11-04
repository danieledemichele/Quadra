# Quadra — la spesa che torna

Legge le foto degli scontrini con un modello di visione (Groq di default) e, dopo la tua revisione, crea la riga nel database **Uscite** di Notion: Descrizione, Data, Importo negativo, Tag (Daniele/Ettore dalla cartella), Budget Mensile e, se vuoi, Conto.

## Cosa fa rispetto alla pagina web con il Worker

| | Pagina + Worker | Questa app |
|---|---|---|
| Revisione prima di scrivere su Notion | no | **sì**: foto accanto ai dati, modificabili |
| Scelta del Conto | no (a mano in Notion) | **sì**, elenco preso da Notion |
| Limite di 6 file / 35 s | sì | **nessuno** (la scansione prosegue finché serve) |
| Storico locale e ricerca | no | **sì** |
| Doppioni (stessa foto, stesso negozio+data+importo) | no | **segnalati / scartati** |
| Correzioni ricordate (es. "Sup. Tiziano" → Conad) | no | **sì** |
| Altri modelli oltre a Groq | solo cambio del codice | **da Impostazioni**, con ordine di riserva |
| Foto da questo PC (trascinamento) | no | **sì** |

Il Worker può restare com'è: è un'alternativa da telefono.

## Installazione

Serve Node 20 o superiore (solo per costruire/avviare dai sorgenti).

```bash
cd quadra
npm install
npm start
```

Se all'avvio compare un errore su `chrome-sandbox` (capita su alcune configurazioni di Ubuntu):

```bash
npm run start:nosandbox
```

### Pacchetto installabile

```bash
npm run dist
sudo apt install ./dist/quadra_1.0.0_amd64.deb     # oppure l'AppImage in dist/
```

Per l'AppImage su Ubuntu 22.04 serve `libfuse2` (`sudo apt install libfuse2`).

## Prima configurazione (Impostazioni)

1. **Dropbox** — inserisci App key e App secret della tua app Dropbox (la stessa usata dal Worker; permessi `files.metadata.read`, `files.content.read`, `files.content.write`). Premi *1. Apri Dropbox e autorizza*, copia il codice mostrato e incollalo, poi *2. Collega*. Il collegamento è nuovo: il vecchio token del Worker non si riusa. Il codice scade in pochi minuti.
2. **Notion** — incolla la chiave dell'integrazione (già collegata a Uscite e Budget Mensile). Gli ID dei due database sono già compilati. *Prova la connessione* dice quanti conti trova, se il budget del mese esiste e se manca qualche colonna.
3. **Modelli** — incolla la chiave Groq. *Prova* su ogni modello controlla che risponda.
4. **Salva modifiche.**

## Uso quotidiano

1. Scatti le foto, finiscono in `/Daniele` o `/Ettore` su Dropbox (anche in sottocartelle per mese).
2. **Scansiona Dropbox**: l'app scarica le foto nuove, le legge e le mette in *Da rivedere*. Su Dropbox non cambia nulla finché non confermi.
3. Per ogni scontrino controlli negozio, data, importo, scegli il **Conto** e premi **Invia a Notion** (`Ctrl+Invio`). La foto viene anche **allegata alla riga di Notion** (colonna *Allegati*, si può disattivare in Impostazioni → Avanzate) e il file originale va in `Elaborati` su Dropbox.
4. **Scarta** (`Canc`) sposta la foto in `Scartati`. **Rileggi** rifà la lettura col modello.
5. *Invia i N pronti* manda in blocco quelli senza avvisi (con lo stesso Conto, se vuoi).

Puoi anche trascinare foto dal PC nella finestra, oppure usare *Importa foto…*: ti chiede per chi sono.

Gli **avvisi** gialli indicano cose da controllare: dato non letto, data nel futuro o di oltre 4 mesi fa, importo sopra 500 €, stesso negozio+data+importo già presenti. L'avviso azzurro "Negozio fuori lista" significa che la formula Categoria di Notion probabilmente non lo riconoscerà.

Se correggi il nome di un negozio prima di inviare, l'app **impara la correzione** per le volte dopo (Impostazioni → Negozi e correzioni, dove puoi anche toglierla).

### Scorciatoie

`Ctrl+Invio` invia · `Canc` scarta · `↑ ↓` (o `j k`) cambiano scontrino.

## Aggiungere altri modelli o provider

Impostazioni → *Modelli di lettura*.

- **Altro modello Groq**: *+ Aggiungi modello*, scegli il provider Groq e scrivi il nome (o *Elenca modelli* per vederli tutti).
- **Altro provider** (OpenRouter, OpenAI, Ollama sul tuo PC, qualunque servizio compatibile OpenAI): scegli il tipo accanto a *+ Aggiungi provider*, incolla la chiave, poi aggiungi i suoi modelli.
- **Ordine**: i modelli si provano dall'alto. Se uno ha esaurito il limite o non risponde, si passa al successivo; il primo resta in pausa finché il limite non si azzera.
- Il modello **deve supportare le immagini**. Se un modello dà errore sul formato JSON, togli la spunta *JSON* (l'app comunque riprova da sola senza).

## Dati e riservatezza

- Tutto sta in `~/.config/quadra/`: `settings.json` (chiavi cifrate col portachiavi di sistema se disponibile, altrimenti file con permessi 600), `items.json` (storico), `cache/` (foto ridotte).
- Al modello va solo la foto ridotta (max 2 megapixel, regolabile) di ogni scontrino; a Notion solo negozio, data, importo, tag, conto.
- Le chiavi non arrivano mai alla parte grafica dell'app.

## Problemi comuni

- **«Mi sono fermato: i modelli non rispondono»** — limite giornaliero o errore del provider. Le foto restano su Dropbox: riprova più tardi o aggiungi un modello di riserva.
- **«Budget Mensile … non trovato»** — manca la riga del mese in Budget Mensile (campo *Mese (testo)* = `AAAA-MM`): la voce viene creata ma può non comparire nelle viste filtrate.
- **Categoria vuota dopo l'invio** — il nome del negozio non contiene nessuna delle parole della formula; correggilo e aggiungilo alla lista in Impostazioni.
- **Formato HEIC** non supportato: scatta in JPEG.
- **Cartella non trovata** — controlla il percorso in *Persone e cartelle* (es. `/Daniele`).

## Sviluppo

```bash
npm test          # 10 test sul nucleo con server finti + prova dell'interfaccia (se c'è Playwright)
```

Struttura: `main.js` (processo principale, IPC, finestra), `preload.js` (ponte sicuro), `src/core/` (Dropbox, Notion, modelli, flusso), `src/renderer/` (interfaccia).
