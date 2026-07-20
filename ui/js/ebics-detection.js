// ebics-detection.js — read-only controller-family detection
import { state, socket, switchTab, addLog } from './shared.js';

// Development preview switch. Keep true while building/reviewing the separate
// cards without hardware. Set to false to show them only after EBICS detection.
export const EBICS_UI_PREVIEW_WITHOUT_DETECTION = true;

export const CONTROLLER_FLAVOR = Object.freeze({
    UNKNOWN: 'unknown',
    DETECTING: 'detecting',
    FACTORY: 'factory_bafang',
    EBICS: 'ebics',
});

const DETECTION_TIMEOUT_MS = 1800;
let detectionTimer = null;

function updateDetectionUI() {
    const badge = document.getElementById('controllerFlavorBadge');
    const flavor = state.controllerFlavor || CONTROLLER_FLAVOR.UNKNOWN;
    const labels = {
        [CONTROLLER_FLAVOR.UNKNOWN]: 'Controller: unknown',
        [CONTROLLER_FLAVOR.DETECTING]: 'Controller: detecting…',
        [CONTROLLER_FLAVOR.FACTORY]: 'Controller: factory Bafang',
        [CONTROLLER_FLAVOR.EBICS]: 'Controller: EBICS',
    };
    const flavorLabel = labels[flavor] || labels[CONTROLLER_FLAVOR.UNKNOWN];
    const visibleLabel = EBICS_UI_PREVIEW_WITHOUT_DETECTION && flavor !== CONTROLLER_FLAVOR.EBICS
        ? `${flavorLabel} · UI preview`
        : flavorLabel;
    if (badge) {
        badge.textContent = visibleLabel;
        badge.dataset.flavor = flavor;
        badge.title = state.controllerFlavorReason || '';
    }

    const showEbics = isEbicsUIAvailable();
    document.querySelectorAll('[data-ebics-only="true"]').forEach((button) => {
        button.style.display = showEbics ? '' : 'none';
    });

    const value = document.getElementById('ebicsDetectionState');
    const reason = document.getElementById('ebicsDetectionReason');
    if (value) value.textContent = visibleLabel;
    if (reason) reason.textContent = state.controllerFlavorReason || 'N/A';

    if (!showEbics && document.querySelector('.tab-button.active[data-ebics-only="true"]')) {
        switchTab('controller');
    }
    window.dispatchEvent(new CustomEvent('controller-flavor-changed', { detail: { flavor } }));
}

export function isEbicsUIAvailable() {
    return EBICS_UI_PREVIEW_WITHOUT_DETECTION || state.controllerFlavor === CONTROLLER_FLAVOR.EBICS;
}

function setFlavor(flavor, reason) {
    state.controllerFlavor = flavor;
    state.controllerFlavorReason = reason;
    updateDetectionUI();
}

export function resetControllerDetection(reason = 'CAN controller is not connected.') {
    state.ebicsDetectionGeneration += 1;
    state.ebicsReceivedBanks = {};
    state.ebicsCompatibilityReceived = {};
    state.ebicsCompatibilityDraft = null;
    state.banksSynced = false;
    state.tuningSynced = false;
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = null;
    setFlavor(CONTROLLER_FLAVOR.UNKNOWN, reason);
}

export function startControllerDetection() {
    if (!state.isCanConnected || socket.readyState !== WebSocket.OPEN) return;

    state.ebicsDetectionGeneration += 1;
    const generation = state.ebicsDetectionGeneration;
    if (detectionTimer) clearTimeout(detectionTimer);
    setFlavor(CONTROLLER_FLAVOR.DETECTING, 'Read-only EBICS Ride Core bank probe in progress.');
    addLog('INFO', 'Detecting controller family with a read-only EBICS bank probe.');
    socket.send('READ_BANK:0');

    detectionTimer = setTimeout(() => {
        if (generation !== state.ebicsDetectionGeneration || state.controllerFlavor === CONTROLLER_FLAVOR.EBICS) return;
        detectionTimer = null;
        setFlavor(
            CONTROLLER_FLAVOR.FACTORY,
            'No valid EBICS Ride Core bank signature was received; factory Bafang interface remains active.',
        );
    }, DETECTION_TIMEOUT_MS);
}

export function confirmEbicsController(reason = 'Valid EBICS Ride Core bank signature and CRC received.') {
    state.ebicsDetectionGeneration += 1;
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = null;
    setFlavor(CONTROLLER_FLAVOR.EBICS, reason);
}

export function refreshControllerDetectionUI() {
    updateDetectionUI();
}

document.getElementById('ebicsProbeAgainButton')?.addEventListener('click', startControllerDetection);
updateDetectionUI();
