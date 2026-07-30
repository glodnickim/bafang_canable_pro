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
    // Never hide everything: the eVistDrive buttons are themselves hidden until the
    // controller is recognised, so blindly hiding the factory ones could leave an
    // empty tab bar with no way back.
    const ebicsVisible = Array.from(document.querySelectorAll('.tab-button[data-ebics-only="true"]'))
        .some((btn) => btn.style.display !== 'none');
    if (hide && !ebicsVisible) hide = false;
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
    // Hidden by default: the eVistDrive tabs are the ones in use, and the factory
    // tabs are on their way out. A stored preference always wins, so anyone who
    // has already unticked this keeps seeing them.
    const stored = localStorage.getItem(STORAGE_KEY);
    const saved = stored === null ? true : stored === '1';
    checkbox.checked = saved;
    // Hide the buttons immediately; defer the active-tab correction so it runs
    // after init.js has done its initial switchTab('controller').
    apply(saved, false);
    setTimeout(() => apply(checkbox.checked, true), 0);

    checkbox.addEventListener('change', () => {
        localStorage.setItem(STORAGE_KEY, checkbox.checked ? '1' : '0');
        apply(checkbox.checked, true);
    });

    // The eVistDrive buttons appear only once the controller is recognised, so the
    // hide decision has to be re-taken then — otherwise the guard above would have
    // refused to hide anything at startup and never reconsidered.
    window.addEventListener('controller-flavor-changed', () => apply(checkbox.checked, true));
}
