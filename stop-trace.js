'use strict';
const fs = require('fs');
const path = require('path');
const { COMMAND, decodeStatus, Download } = require('./stop-trace-protocol');

// Independent of sniffer filters and browser lifetime. No motor-control writes.
class StopTraceService {
    constructor({ canbus, broadcast, logDir, now = Date.now, autoTimer = true, isBusy = () => false }) {
        this.canbus = canbus; this.broadcast = broadcast; this.now = now;
        this.logDir = logDir || path.join(process.pkg ? path.dirname(process.execPath) : __dirname, 'logs', 'stop-trace');
        this.clients = new Set(); this.status = null; this.at = 0; this.lastPoll = 0;
        this.pending = null; this.transfer = null; this.saved = null; this.error = '';
        this.automatic = true; this.enabled = false; this.retryAt = 0; this.retries = 0;
        this.lastFile = null; this.completed = 0;
        this.isBusy = isBusy;
        this.raw = f => { try { this.onRaw(f); } catch (e) { this.fail(e.message); } };
        canbus.on('raw_frame_received', this.raw);
        if (autoTimer) { this.timer = setInterval(() => this.tick(), 250); this.timer.unref(); }
    }
    connected() { return !!this.canbus.isConnected(); }
    fresh() { return this.connected() && this.status && this.now() - this.at < 4000; }
    send(id) {
        if (this.isBusy()) return;
        if (!this.connected()) return this.fail('Brak połączenia z adapterem CAN.');
        try { Promise.resolve(this.canbus.sendRawFrame(id, '')).catch(e => this.fail('Nie udało się wysłać polecenia: ' + e.message)); }
        catch (e) { this.fail(e.message); }
    }
    poll() { this.lastPoll = this.now(); this.send(COMMAND.status); }
    handle(ws, command) {
        if (!['STOP_TRACE_SUBSCRIBE', 'STOP_TRACE_ARM', 'STOP_TRACE_DUMP', 'STOP_TRACE_REFRESH', 'STOP_TRACE_AUTO_ON', 'STOP_TRACE_AUTO_OFF'].includes(command)) return false;
        this.clients.add(ws);
        this.enabled = true;
        if (command === 'STOP_TRACE_AUTO_ON') { this.automatic = true; this.retries = 0; this.retryAt = 0; this.error = ''; }
        if (command === 'STOP_TRACE_AUTO_OFF') {
            this.automatic = false;
            if (this.pending?.automatic && this.pending.phase === 'status') this.pending = null;
        }
        if (command === 'STOP_TRACE_ARM' || command === 'STOP_TRACE_DUMP') {
            this.automatic = false; // explicit manual operation leaves the automatic loop
            if (!this.pending && !this.transfer) {
                this.error = '';
                this.pending = { action: command === 'STOP_TRACE_ARM' ? 'arm' : 'dump', phase: 'status', started: this.now() };
                this.poll();
            }
        } else if (this.connected()) this.poll();
        this.publish(); return true;
    }
    unsubscribe(ws) { this.clients.delete(ws); }
    mayReplace(s) {
        // NO_TRIGGER is an expired waiting window, not a recorded stop. An overrun
        // is diagnostic evidence: download that window instead of discarding it.
        return s.state === 0 || (s.state === 3 && (this.saved?.generation === s.generation ||
            (this.automatic && s.reason === 4 && !s.overrun)));
    }
    autoStep() {
        if (this.isBusy() || !this.enabled || !this.automatic || !this.fresh() || this.pending || this.transfer || this.now() < this.retryAt) return;
        const s = this.status;
        if (!s.available || s.exporting || s.pending || s.state === 1 || s.state === 2) return;
        const action = this.mayReplace(s) ? 'arm' : (s.state === 3 && s.frozen ? 'dump' : null);
        if (!action) return;
        this.error = '';
        this.pending = { action, phase: 'status', started: this.now(), automatic: true };
        this.poll(); // get authoritative fresh status again before a write
    }
    fail(message) {
        this.pending = null; this.error = message;
        if (this.enabled && this.automatic) {
            this.retryAt = this.now() + 5000;
            if (++this.retries >= 3) { this.automatic = false; this.error += ' Automatyczne próby wstrzymane po trzech błędach.'; }
            else this.error += ' Ponowię automatycznie za chwilę.';
        }
        const t = this.transfer; this.transfer = null;
        if (t) { t.stream.end(); this.error += ' Zapis częściowy zachowany: ' + t.file; }
        this.publish();
    }
    tick() {
        if (this.isBusy()) { if (this.clients.size) this.publish(); return; }
        if (!this.connected()) {
            if (this.pending || this.transfer) this.fail('Utracono połączenie z adapterem.');
            this.status = null; this.at = 0; this.saved = null;
        } else {
            if (this.status && this.now() - this.at >= 4000) this.saved = null;
            if (this.pending && this.now() - this.pending.started > 5000) this.fail('Sterownik nie potwierdził polecenia. Spróbuj ponownie.');
            if (this.transfer && !this.transfer.saving && this.now() - this.transfer.lastFrame > 60000) {
                this.fail('Przez minutę nie dotarły dane. Zatrzymaj silnik i koło, a następnie ponów pobieranie.');
            }
            if ((this.clients.size || (this.enabled && this.automatic) || this.pending || this.transfer) && this.now() - this.lastPoll >= (this.pending ? 500 : 1500)) this.poll();
            this.autoStep();
        }
        if (this.clients.size) this.publish();
    }
    publish() {
        const fresh = this.fresh(), s = this.status, t = this.transfer;
        let label = 'Łączenie ze sterownikiem…', hint = 'Połącz adapter CAN i włącz sterownik.';
        if (!this.connected()) label = 'Brak połączenia z CAN';
        else if (!fresh) { label = 'Brak aktualnej odpowiedzi sterownika'; hint = 'Panel wymaga firmware NORMAL z STOP-TRACE (np. 0.514).'; }
        else if (!s.available) { label = 'Rejestrator niedostępny'; hint = 'Wgraj wersję NORMAL z STOP-TRACE. Wersja DIAG nie obsługuje tego pomiaru.'; }
        else if (s.state === 0) { label = 'Gotowy do rozpoczęcia'; hint = 'Kliknij „Rozpocznij pomiar”.'; }
        else if (s.state === 1) { label = 'Gotowy — wykonaj próbę'; hint = 'W ciągu 30 sekund uruchom wspomaganie, potem przestań pedałować i poczekaj na zatrzymanie.'; }
        else if (s.state === 2) { label = 'Trwa zapis zatrzymania'; hint = 'Poczekaj, aż silnik i koło zatrzymają się.'; }
        else if (s.state === 3) {
            label = 'Pomiar gotowy do pobrania'; hint = 'Zatrzymaj silnik i koło, następnie kliknij „Pobierz zapis”.';
            if (s.reason === 4) { label = 'Nie zarejestrowano zatrzymania'; hint = 'Upłynęło 30 sekund bez wyzwolenia. Pobierz zapis, potem rozpocznij kolejną próbę.'; }
            else if (s.reason === 2 || s.reason === 3) hint = 'Zapis zakończył limit czasu lub pamięci. Pobierz go do sprawdzenia.';
            if (this.saved && this.saved.generation === s.generation) { label = 'Plik zapisany — pomiar pobrany'; hint = 'Możesz rozpocząć kolejny pomiar.'; }
        }
        if (this.pending) { label = this.pending.phase === 'status' ? 'Sprawdzam stan sterownika…' : 'Czekam na potwierdzenie pomiaru…'; hint = 'Poczekaj na komunikat „Gotowy — wykonaj próbę”.'; }
        if (t) {
            label = t.saving ? 'Zapisuję plik…' : 'Pobieranie zapisu…';
            hint = this.now() - t.lastFrame > 5000 ? 'Czekam na dane. Silnik i koło muszą stać; pobieranie wznowi się automatycznie.' : 'Poczekaj na komunikat „Plik zapisany”.';
        }
        if (this.automatic && !this.error && fresh && s.available && !t) {
            if (this.pending || s.state === 0) { label = 'Przygotowuję pomiar automatycznie…'; hint = 'Poczekaj na „Gotowy — wykonaj próbę”.'; }
            else if (s.state === 1) { label = 'Gotowy — wykonaj próbę'; hint = 'Uruchom wspomaganie i przestań pedałować. Niczego nie klikaj — zapis pobierze się automatycznie.'; }
            else if (s.state === 3) { label = s.reason === 4 ? 'Odnawiam gotowość do próby…' : 'Pomiar zakończony — pobieram automatycznie'; hint = 'Poczekaj na zatrzymanie silnika i koła oraz gotowość do następnej próby.'; }
        }
        if (this.isBusy()) { label = 'Trwa aktualizacja firmware'; hint = 'Pomiary wznowią się automatycznie po zakończeniu aktualizacji.'; }
        const idle = !this.isBusy() && fresh && s.available && !this.pending && !t && !s.exporting && !s.pending;
        this.broadcast('STOP_TRACE_STATUS:' + JSON.stringify({ label, hint, error: this.error,
            canArm: !!(idle && (s.state === 0 || (s.state === 3 && this.saved?.generation === s.generation))),
            canDump: !!(idle && s.state === 3 && s.frozen), generation: fresh ? s.generation : null,
            samples: fresh ? s.count : null, received: t ? t.assembler.parts.size : 0,
            expected: t ? t.assembler.expected : null, downloading: !!t, file: this.lastFile || this.saved?.file || null,
            automatic: this.automatic, completed: this.completed }));
    }
    onRaw(f) {
        if (this.isBusy()) return;
        if (!f || f.frameType === 'echo' || f.frameType === 'error' || (f.can_id & 0x60000000) || !(f.data instanceof DataView)) return;
        const id = f.can_id & 0x1fffffff;
        if (![0x022a6033, 0x022b6033, 0x022a6034, 0x022b6034].includes(id) && !(id >= 0x10300 && id <= 0x10307)) return;
        if (f.can_dlc > 8 || f.can_dlc > f.data.byteLength) return;
        const d = Buffer.from(Array.from({ length: f.can_dlc }, (_, i) => f.data.getUint8(i)));
        if (id === 0x022a6033 && d.length === 8) {
            const s = decodeStatus(d);
            if (!s) return this.fail('Nieobsługiwana odpowiedź rejestratora.');
            // A changed capture invalidates the saved-generation latch (including reset).
            if (this.status && (s.generation !== this.status.generation || (s.state < 3 && this.status.state === 3))) this.saved = null;
            this.status = s; this.at = this.now();
            const p = this.pending;
            if (p?.phase === 'status') {
                if (!s.available) return this.fail('Ten firmware nie udostępnia STOP-TRACE. Potrzebna jest wersja NORMAL.');
                if (s.pending || s.exporting) return this.fail('Sterownik kończy poprzednią operację. Poczekaj chwilę.');
                if (p.action === 'arm') {
                    if (!this.mayReplace(s)) return this.fail('Najpierw pobierz bieżący pomiar lub poczekaj na jego zakończenie.');
                    p.phase = 'armed'; p.generation = s.generation; p.started = this.now(); this.send(COMMAND.arm);
                } else {
                    if (s.state !== 3 || !s.frozen) return this.fail('Pomiar nie jest jeszcze gotowy do pobrania.');
                    this.pending = null; this.startDownload(s.generation);
                }
            } else if (p?.phase === 'armed' && s.generation === ((p.generation + 1) & 255) && s.state >= 1 && !s.pending) {
                this.pending = null; this.saved = null;
                this.retries = 0;
            }
            if (this.transfer && (s.generation !== this.transfer.assembler.generation || s.state !== 3)) return this.fail('Stan pomiaru zmienił się podczas pobierania.');
            this.publish(); return;
        }
        if ((id === 0x022b6033 && this.pending?.action === 'arm') || (id === 0x022b6034 && this.transfer)) return this.fail('Sterownik odrzucił polecenie. Odczekaj chwilę i ponów.');
        if (id === 0x022a6033 && d.length === 0 && this.pending?.phase === 'armed') { this.poll(); return; }
        const t = this.transfer;
        if (!t || t.saving || id < 0x10300 || id > 0x10307) return;
        t.lastFrame = this.now();
        t.stream.write(`${new Date(this.now()).toISOString()} ID:${(id + 0x80000000).toString(16).toUpperCase()} DLC:${d.length} Data:${d.toString('hex').match(/../g).join(' ').toUpperCase()}\n`);
        const result = t.assembler.feed(id, d);
        if (result) {
            t.saving = true;
            t.stream.end(() => {
                if (this.transfer !== t) return;
                try {
                    fs.writeFileSync(t.file + '.json', JSON.stringify(result, null, 2), { flag: 'wx' });
                    this.saved = { generation: result.generation, file: t.file };
                    this.lastFile = t.file; this.completed++; this.retries = 0; this.retryAt = this.now() + 1500;
                    this.transfer = null; this.error = '';
                    if (result.irq_body_over_budget) {
                        this.automatic = false;
                        this.error = 'Plik zapisany. Pomiar wykazał przekroczenie czasu FOC — automatyczne próby wstrzymane. Napisz „sprawdź log”.';
                    }
                    this.publish();
                } catch (e) { this.fail('Nie udało się zapisać wyniku: ' + e.message); }
            });
        }
    }
    startDownload(generation) {
        fs.mkdirSync(this.logDir, { recursive: true });
        const file = path.join(this.logDir, `stop-trace-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}-g${generation}.log`);
        // Exclusive creation before WRITE: a failed file operation must never claim success.
        const fd = fs.openSync(file, 'wx');
        const stream = fs.createWriteStream(file, { fd });
        const t = { assembler: new Download(generation), stream, file, lastFrame: this.now(), saving: false };
        this.transfer = t;
        stream.on('error', e => { if (this.transfer === t) this.fail('Błąd zapisu pliku: ' + e.message); });
        stream.write('# STOP-TRACE; pełność potwierdza wyłącznie plik .json z COMPLETE_CRC_OK\n');
        this.send(COMMAND.dump);
    }
    cleanup() { clearInterval(this.timer); this.canbus.removeListener('raw_frame_received', this.raw); if (this.transfer) this.transfer.stream.end(); }
}
module.exports = { StopTraceService };
