# Progetto: Fit Companion — App Tapis Roulant + Alimentazione + Peso Forma

## 1. Visione

Non solo un telecomando per il tapis roulant Domyos T900D, ma un **assistente personale per il percorso verso il peso forma**, che mette in relazione tre dati che di solito restano separati:

- **Peso corporeo** (andamento nel tempo vs obiettivo)
- **Alimentazione** (Guida Alimentare Flessibile)
- **Allenamento** (sessioni sul tapis roulant, controllate/monitorate via Bluetooth FTMS)

L'idea centrale: l'app **decide/suggerisce l'allenamento del giorno** guardando dove sei rispetto al peso forma e cosa hai mangiato/mangerai, invece di lasciare che l'utente inventi ogni volta intervalli a caso.

## 2. Obiettivo dell'utente

- Raggiungere e mantenere il **peso forma** (target configurabile).
- Avere allenamenti mirati, non generici: più intensi/lunghi se si è indietro rispetto al target, di mantenimento se si è in linea.
- Sfruttare il meccanismo di **bonus alimentare nei giorni di allenamento** già previsto dalla guida (vedi §5) come leva combinata dieta+attività.
- Poter **registrare un allenamento fatto manualmente** e riproporlo identico o con difficoltà aumentata (es. "+10%"), senza dover ridefinire tutto da zero ogni volta (vedi §6.5).

## 3. Ricerca tecnica: comunicazione con il T900D

Ho verificato lo stato dell'arte prima di scrivere codice, per non progettare su ipotesi sbagliate.

**Cosa è confermato:**
- Il **T900D è ufficialmente FTMS-compatibile** — è elencato esplicitamente tra i prodotti supportati nel repo ufficiale [Decathlon/domyos-developers](https://github.com/Decathlon/domyos-developers).
- Decathlon fornisce un esempio ufficiale (`ftms-treadmill-web-console`) che si connette via **Web Bluetooth** al servizio FTMS (`0x1826`) e legge la caratteristica *Treadmill Data* (`0x2acd`) con notifiche in tempo reale (velocità, distanza, inclinazione, calorie, tempo — layout a flag come da standard). Questa parte, quindi, è **a rischio basso**: leggere i dati live funziona in modo standard e documentato.
- Progetti terzi consolidati come [qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift) fanno da "bridge" tra macchine Domyos e app come Zwift, a conferma che l'ecosistema FTMS Domyos è utilizzabile da app esterne.

**Cosa NON è confermato (rischio reale da non sottovalutare):**
- **Nessuna fonte trovata conferma che il T900D accetti comandi in scrittura** sul *Fitness Machine Control Point* (`0x2AD9`, l'unico modo standard per impostare velocità/inclinazione da remoto). L'esempio ufficiale Decathlon **legge soltanto**, non scrive mai sul Control Point.
- Un thread su un forum Zwift, discutendo l'integrazione Domyos, riporta letteralmente che *"Domyos doesn't conform to Bluetooth FTMS or ANT+ FE-C standards"* per il controllo, suggerendo che serva un bridge proprietario (tipo QZ) anche quando la telemetria FTMS è disponibile.
- Un utente con un Domyos T540C ha segnalato errori di connessione Bluetooth con l'integrazione FTMS di Home Assistant, senza soluzione trovata nel thread.
- **Conclusione pratica**: è comune, tra i tapis roulant di fascia consumer, che il FTMS sia implementato *solo in lettura* (telemetria) mentre il controllo reale (velocità/inclinazione) resti riservato ai pulsanti fisici o a un protocollo proprietario non documentato. Non possiamo dare per scontato che il Control Point funzioni sul T900D finché non lo testiamo sul dispositivo reale.

**Prossimo passo concreto (prima di scrivere qualsiasi motore di allenamento automatico):**
Un test rapido e a costo zero: aprire Chrome, andare su `chrome://bluetooth-internals` oppure usare una paginetta HTML minima con `navigator.bluetooth.requestDevice({filters:[{services:[0x1826]}]})`, connettersi al T900D, e provare a scrivere un comando "Request Control" (`0x00`) seguito da "Set Target Speed" (`0x02`) sulla caratteristica `0x2AD9`, osservando se il tapis roulant reagisce davvero o se restituisce solo un errore/non risposta. Questo test **va fatto prima** di investire tempo nel motore di controllo automatico (§6.1). È già pronto come file `test-ftms.html` nella stessa cartella.

Questa incertezza è il motivo per cui la funzione di **registrazione allenamenti** (§6.5, richiesta esplicitamente) è stata progettata per funzionare **anche se il controllo remoto non fosse disponibile** — vedi sotto.

**Aggiornamento — analisi statica dell'app ufficiale Kinomap (evidenza forte a favore della scrittura FTMS):**
Kinomap (app partner ufficiale Decathlon) include al suo interno l'SDK proprietario Decathlon **"Domyos Connect"** (pacchetto `com.appdevice.domyos`), estratto e ispezionato direttamente dall'APK installato sul telefono. Emergono due percorsi paralleli per controllare un tapis roulant Domyos:

1. **Protocollo proprietario legacy** (classi `DCCommand`, `DCTreadmillPressedButtonSpeed1-8`, `SpeedPlus/SpeedMinus`, `Incline1-8`, `InclinePlus/InclineMinus`, `StartPause`, `Stop`...) — controlla il tapis roulant **simulando la pressione dei tasti fisici** invece di impostare un valore assoluto. Usato per l'equipment type `KINOMAP_EQUIPMENT_ID_BLE_DOMYOS_TREADMILL`, presumibilmente sui modelli Domyos più datati, pre-FTMS.
2. **Implementazione FTMS standard completa** (classi `DCFTMSCommandHandler`, `DCFTMSControlPointHandler`) con metodi `sendSpeedCommand`, `sendInclineCommand`, `sendStartCommand`, `sendPauseCommand`, `sendStopCommand`, che scrivono esattamente sulla caratteristica `0x2AD9` con gli opcode standard. Sono presenti stringhe di log di gestione errori reali ("FTMS command rejected, permission error", "op code not supported", "FTMS command timeout") — prova che questo percorso è **attivamente esercitato in produzione**, non codice morto/inutilizzato. Usato per l'equipment type `KINOMAP_EQUIPMENT_ID_BLE_FTMS_TREADMILL`.

Dato che il T900D è ufficialmente nella lista FTMS di Decathlon (§3), è plausibile che Kinomap lo tratti come `BLE_FTMS_TREADMILL` e usi il percorso (2) — lo stesso su cui è basato il nostro `test-ftms.html`. Non è una certezza assoluta (non è stata isolata la logica esatta di selezione tra i due percorsi), ma alza sensibilmente la probabilità che la scrittura sul Control Point funzioni davvero sul dispositivo reale.

**Bonus pratico trovato**: i tapis roulant Domyos annunciano il proprio nome Bluetooth con il prefisso **`domyos-tc-`** ("treadmill console"), diverso dai prefissi delle altre attrezzature (`domyos-bike-`, `domyos-row-`, `domyos-el-`, ecc.). `test-ftms.html` è già stato aggiornato per usarlo come filtro alternativo nella scansione, utile nel caso il T900D non annunci l'UUID FTMS direttamente nel pacchetto di advertising (quirk comune in molti dispositivi BLE, che espongono il servizio solo dopo la connessione GATT).

## 4. Il meccanismo del bonus (piano alimentare)

Dalla `Guida_Alimentare_Flessibile.pdf`: **solo nei giorni in cui si fanno 30-40 minuti di camminata/tapis roulant**, si sblocca un bonus a scelta tra +20g pasta/riso (o +30g pane) nel pasto successivo, 1 banana grande pre-workout, o +10g di olio EVO extra. Questo è il punto di aggancio naturale tra i moduli allenamento e alimentazione: l'app sa se oggi è "giorno di allenamento" (perché una sessione è stata registrata) e può ricordare/sbloccare il bonus di conseguenza.

## 5. Struttura del piano alimentare (riferimento)

- **Colazione**: fissa (fette biscottate + marmellata, caffè, yogurt greco o latte).
- **Pranzo e Cena**: schema "1 Carboidrato + 1 Proteina + 1 Verdura", ciascuno scelto da una lista con grammature precise a crudo.
- **Spuntini**: 2 al giorno, a scelta tra 3 opzioni.
- **Condimenti**: olio EVO 20g/die, salsa di soia, zenzero marinato, liberi.

## 6. Moduli funzionali

### 6.1 Controllo Tapis Roulant (BLE FTMS) — *dipende dall'esito del test in §3*
- Connessione Web Bluetooth al servizio FTMS (`0x1826`).
- Lettura realtime *Treadmill Data* (`0x2ACD`): velocità, inclinazione, distanza, calorie, tempo — **funziona quasi certamente** (confermato da esempio ufficiale Decathlon).
- Comandi via *Control Point* (`0x2AD9`): Request Control, Set Target Speed, Set Target Inclination — **da validare sul dispositivo reale**. Se non funziona, l'app resta comunque utile in modalità "monitoraggio + guida a schermo" (vedi 6.5).

### 6.2 Diario Peso
- Inserimento peso, target "peso forma" configurabile.
- Grafico andamento + media mobile 7gg, scostamento dal target.

### 6.3 Storico Allenamenti
- Ogni sessione salvata: data, durata, distanza, velocità media/max, inclinazione, calorie stimate.
- Statistiche aggregate settimana/mese.

### 6.4 Piano Alimentare Interattivo
- Checklist giornaliera basata sulla Guida Alimentare (§5).
- Giorno marcato come "allenamento" automaticamente se c'è una sessione registrata quel giorno → mostra il bonus disponibile (§4).

### 6.5 Registrazione e Replay Allenamenti — *nuova funzione, dettaglio richiesto*

**Come funziona in pratica:**

1. **Modalità "Allenamento libero"**: l'utente avvia una sessione e regola manualmente velocità/inclinazione durante l'allenamento (sui pulsanti fisici del tapis roulant, oppure da app se il Control Point risulta scrivibile). L'app **ascolta in continuo** la telemetria FTMS (§6.1) e registra ogni cambiamento: `{timestamp, velocità, inclinazione}`.
2. **A fine sessione**: l'app compatta la registrazione grezza in una sequenza di step puliti, raggruppando le letture consecutive stabili in un unico step `{durata, velocità, inclinazione}` (es. tolleranza ±0.2 km/h per non spezzare uno step per rumore del sensore). Il risultato è lo stesso formato dati usato dal motore intervalli (§6.1) — è già "eseguibile".
3. **Scelta dell'utente**: a fine allenamento, popup con 3 opzioni:
   - **Non salvare** (sessione registrata solo nello storico, §6.3, ma non riutilizzabile come template).
   - **Salva come "Allenamento preferito"** con un nome (es. "Corsa media 30 min") → riutilizzabile identico in futuro.
   - **Salva e riparti più difficile**: applica subito una variante con un moltiplicatore (default **+10%**, modificabile) su velocità e/o inclinazione di ogni step, e la propone come nuovo allenamento pronto.
4. **Riutilizzo futuro**: dalla libreria di allenamenti salvati, per ognuno è disponibile sia "Ripeti uguale" sia "Ripeti con +X% difficoltà" (lo scalare non è fisso al 10%, è un parametro impostabile ogni volta).
5. **Due modalità di esecuzione del replay** (a seconda dell'esito del test §3):
   - **Auto-drive** (se il Control Point scrive davvero): l'app invia da sola i comandi di velocità/inclinazione ad ogni cambio di step, come un allenamento pianificato.
   - **Guidato** (se il Control Point non è scrivibile): l'app mostra a schermo, in anticipo di qualche secondo, "il prossimo step: X km/h, Y% inclinazione tra 10s" con un segnale sonoro, e l'utente regola manualmente sui pulsanti fisici. La registrazione della sessione (telemetria in lettura) continua a funzionare comunque.

> Il punto di forza di questo design: **funziona indipendentemente dal fatto che il T900D accetti comandi in scrittura o no**. Se il controllo remoto risultasse non disponibile, l'app degrada a "coach a schermo" invece di "autopilota", ma tutte le funzioni di registrazione/libreria/scalatura difficoltà restano intatte.

### 6.6 Motore Allenamenti Personalizzati
Suggerisce l'allenamento del giorno combinando:
- **Scostamento dal peso forma**: più lontano dal target → sessioni più lunghe/intense; vicino al target → mantenimento.
- **Storico recente** (§6.3): evita alta intensità 2 giorni consecutivi, tiene conto della frequenza settimanale.
- **Libreria di allenamenti salvati** (§6.5): può proporre "oggi tocca a [nome allenamento salvato], magari con +10%" invece di generare sempre sequenze nuove da zero.

> Parte come **regole semplici e trasparenti** (if/else configurabili), non come algoritmo black-box.

## 7. Modello dati (bozza)

```ts
interface WeightEntry {
  date: string;       // ISO date
  weightKg: number;
}

interface UserGoal {
  targetWeightKg: number;
  targetDate?: string;
}

interface WorkoutStep {
  durationSec: number;
  speedKmh: number;
  inclinePct: number;
}

interface WorkoutTemplate {
  id: string;
  name: string;
  steps: WorkoutStep[];
  createdFromSessionId?: string;   // se nato da una registrazione
  scaledFromTemplateId?: string;   // se è una variante "+X%" di un altro template
  scaleFactor?: number;            // es. 1.10
}

interface WorkoutSession {
  id: string;
  date: string;
  templateId?: string;             // se eseguita da un template
  executionMode: "auto-drive" | "guided" | "manual-unrecorded";
  rawTelemetry?: { t: number; speedKmh: number; inclinePct: number }[]; // registrazione grezza
  steps: WorkoutStep[];             // versione compattata
  actual?: { avgSpeedKmh: number; maxSpeedKmh: number; distanceKm: number; durationSec: number };
}

interface MealDayLog {
  date: string;
  isTrainingDay: boolean;   // derivato automaticamente da WorkoutSession del giorno
  lunch: { carb?: string; protein?: string; veg?: string };
  dinner: { carb?: string; protein?: string; veg?: string };
  snacks: string[];
  bonusUsed?: "carb" | "banana" | "oil";
}
```

## 8. Architettura tecnica

- **Tipo di app**: Web App (HTML5 + TypeScript), installabile come **PWA** per uso da smartphone.
- **Storage locale**: IndexedDB — nessun backend richiesto per l'MVP.
- **UI**: tema scuro, mobile-first.
- **Struttura file**:

```
index.html
style.css
src/
  main.ts            → routing tra le schermate
  ble.ts             → Web Bluetooth + parsing/comandi FTMS
  workout-recorder.ts → ascolto telemetria live + compattazione in step (§6.5)
  workout-engine.ts  → generazione/suggerimento allenamento personalizzato (§6.6)
  workout-runner.ts  → esecuzione step live (auto-drive o guidato) + invio comandi
  storage.ts         → wrapper IndexedDB (pesi, allenamenti, template, pasti)
  weight.ts          → diario peso + grafico
  meal-plan.ts       → dati Guida Alimentare + checklist giornaliera
```

## 9. Roadmap proposta

**Fase 0 — Validazione tecnica (da fare per prima, prima di scrivere il resto)**
0. Test empirico sul T900D reale: la scrittura sul Control Point (`0x2AD9`) funziona? Determina se 6.1/6.5/6.6 saranno "auto-drive" o "guidato" (§3).

**MVP (v1)**
1. Connessione BLE + lettura dati live (funziona in ogni caso) + comandi manuali se il test di Fase 0 lo conferma.
2. Diario peso con grafico e target.
3. Storico allenamenti + **registrazione/compattazione in step e libreria "allenamenti salvati" con variante +X%** (§6.5) — indipendente dall'esito di Fase 0.

**v2**
4. Piano alimentare interattivo con checklist e gestione bonus giorno-allenamento.
5. Motore allenamenti personalizzati basato su regole (peso + storico + libreria salvata).

**v3 (eventuale)**
6. Statistiche avanzate/correlazioni.
7. Raffinamento motore allenamenti.

## 10. Decisioni ancora aperte

- Il peso va inserito manualmente o c'è una bilancia smart da integrare?
- Il target "peso forma" è fisso o rivedibile nel tempo?
- Le regole del motore allenamenti (§6.6) vanno bene come punto di partenza o ci sono vincoli medici/fisici da rispettare?
- Quando si applica "+10% difficoltà", lo scalare va applicato a velocità, a inclinazione, o a entrambe? (proposta: chiederlo ogni volta con un default configurabile)
