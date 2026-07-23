// tab-visibility.js — optional hiding of the legacy factory Bafang tabs.
// Declutters the tab bar when the user configures only through the new
// eVistDrive (Ride Core) cards. Purely a UI-local preference (localStorage);
// does not touch the controller or any protocol.
import { switchTab } from './shared.js';

const STORAGE_KEY = 'hideFactoryTabs';
const checkbox = document.getElementById('hideFactoryTabsCheckbox');

function factoryButtons() {
    return document.querySelectorAll('.tab-button[data-factory-tab="true"]');
}

function firstVisibleTabButton() {
    return Array.from(document.querySelectorAll('.tab-button'))
        .find((b) => b.style.display !== 'none');
}

function apply(hide, correctActive) {
    factoryButtons().forEach((btn) => { btn.style.display = hide ? 'none' : ''; });
    if (hide && correctActive) {
        const active = document.querySelector('.tab-button.active');
        if (active && active.getAttribute('data-factory-tab') === 'true') {
            const visible = firstVisibleTabButton();
            if (visible) switchTab(visible.getAttribute('data-tab'));
        }
    }
}

if (checkbox) {
    const saved = localStorage.getItem(STORAGE_KEY) === '1';
    checkbox.checked = saved;
    // Hide the buttons immediately; defer the active-tab correction so it runs
    // after init.js has done its initial switchTab('controller').
    apply(saved, false);
    setTimeout(() => apply(checkbox.checked, true), 0);

    checkbox.addEventListener('change', () => {
        localStorage.setItem(STORAGE_KEY, checkbox.checked ? '1' : '0');
        apply(checkbox.checked, true);
    });
}
