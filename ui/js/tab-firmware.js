// tab-firmware.js — ES Module
import {
    socket, state,
    fwUpdateElements, tabButtons, connectCanButton,
    safeSetText,
    addLog, updateWriteControlsGating,
} from './shared.js';

// Choosing a file is no longer enough on its own: writing firmware over a link that
// is not there used to start regardless and fail 15 s later. The connection half of
// the condition lives in updateWriteControlsGating, which also supplies the reason.
fwUpdateElements.fileInput.onchange = () => {
    updateWriteControlsGating();
};

fwUpdateElements.startButton.onclick = () => {
    if (!state.isCanConnected) {
        addLog('ERR', 'Cannot start the firmware update: the CANable adapter is not connected.');
        return;
    }
    fwUpdateElements.logArea.innerHTML = '';
    fwUpdateElements.startButton.disabled = true;
    fwUpdateElements.fileInput.disabled = true;
    tabButtons.forEach(button => button.disabled = true);
    connectCanButton.disabled = true;
    const file = fwUpdateElements.fileInput.files[0];
    var reader = new FileReader();
    reader.onload = function (e) {
        const base64Content = e.target.result.split(',')[1];
        socket.send(`FW_UPDATE_START:${fwUpdateElements.modeSelect.value}:${fwUpdateElements.windowInput.value}:${base64Content}`);
        updateFwUpdateProgress(0);
    };
    reader.readAsDataURL(file);
};

fwUpdateElements.clearButton.onclick = () => { fwUpdateElements.logArea.innerHTML = ''; };

export function updateFwUpdateProgress(progress) {
    safeSetText(fwUpdateElements.progressValue, progress);
}

export function addFwUpdateLog(data) {
    const entry = document.createElement('div'); entry.classList.add('log-entry');
    const timeSpan = document.createElement('span'); timeSpan.classList.add('log-time'); timeSpan.textContent = `[${new Date().toLocaleTimeString()}]`;
    const dataSpan = document.createElement('span'); dataSpan.classList.add('log-data');
    dataSpan.textContent = String(data);

    entry.appendChild(timeSpan);
    entry.appendChild(dataSpan);

    fwUpdateElements.logArea.appendChild(entry);
    fwUpdateElements.logArea.scrollTop = fwUpdateElements.logArea.scrollHeight;
}
