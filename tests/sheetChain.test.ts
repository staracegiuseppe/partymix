import { buildShell } from '../src/ui/material';

// Regression: «⋮ → Scarica» closed the menu with history.back(); its late «popstate» closed the MP3/MP4 dialog
// that had just opened, so the format could not be chosen.
describe('a menu item that opens another dialog', () => {
  it('the second dialog stays open after the first one’s back arrives', async () => {
    history.replaceState(null, '', '/');
    document.body.innerHTML = '<div id="root"></div>';
    const shell = buildShell(document.getElementById('root')!, { title: document.createTextNode('T'), actions: [], screens: [{ id: 'a', label: 'A', icon: 'down', body: [] }] });
    const chosen = vi.fn();
    shell.sheet('⋮', '', [{ label: 'Scarica', icon: 'down', run: () => shell.sheet('Scarica «X»', 'scegli il formato', [{ label: 'MP3', icon: 'down', run: chosen }]) }]);
    [...document.querySelectorAll<HTMLButtonElement>('.m-sheet-item')].find((b) => b.textContent === 'Scarica')!.click();
    await new Promise((r) => setTimeout(r, 600)); // the back and its popstate have landed
    const open = [...document.querySelectorAll('.m-sheet')].filter((s) => s.isConnected && s.querySelector('.m-sheet-title')?.textContent === 'Scarica «X»');
    expect(open).toHaveLength(1);
    open[0].querySelector<HTMLButtonElement>('.m-sheet-item')!.click();
    expect(chosen).toHaveBeenCalled();
  });
});
