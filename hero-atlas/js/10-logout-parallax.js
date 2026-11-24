// Clio (the AI study guide) was removed in Hero × Atlas. Keep the routed-view marker other
// modules read, and offer a tiny local "command" hook for the hidden easter eggs that used to be
// typed to Clio (they are now typed into the Study Atlas search box and submitted with Enter).
        const _sv2 = switchView;
        switchView = function (id) { _sv2(id); document.body.dataset.view = id; };
        window.heroWhisper = function (text) { showToast(text, 'info'); };
        window.heroCommand = function (text) {
            text = String(text || '').trim();
            if (!text) return false;
            if (/^manoj cursor[.!?]*$/i.test(text) && window.activateManojCursor) { window.activateManojCursor(); heroWhisper('The Manoj cursor is toggled for this browser.'); return true; }
            return typeof secretAsk === 'function' ? !!secretAsk(text) : false;
        };

        // ================= ADMIN LOG OUT =================
        (function () {
            const save = document.getElementById('save-global-btn'), wrap = document.createElement('div');
            wrap.className = 'flex gap-2 items-center flex-wrap'; save.replaceWith(wrap);
            const out = document.createElement('button');
            out.className = 'cm-btn ghost flex items-center gap-2'; out.innerHTML = '<i data-lucide="log-out" class="w-4 h-4"></i> Log out';
            out.onclick = async () => { sessionStorage.removeItem('mq_devUnlocked'); await lockAdmin('Logged out.'); applyDevScreen(); };
            wrap.append(out, save); lucide.createIcons();
        })();

        // ================= INSTANT APPEARANCE SWITCH + MOUSE PARALLAX =================
        (function () {
            let tx = 0, ty = 0, cx = 0, cy = 0, run = false; const root = document.documentElement;
            const fxMove = (x, y) => {
                const fxA = document.getElementById('fx-a'), fxB = document.getElementById('fx-b');
                if (fxA) fxA.style.translate = `${-x * 22}px ${-y * 22}px`;
                if (fxB) fxB.style.translate = `${x * 60}px ${y * 60}px`;
            };
            const step = () => {
                cx += (tx - cx) * .05; cy += (ty - cy) * .05;
                fxMove(cx, cy);
                if (Math.abs(tx - cx) > .002 || Math.abs(ty - cy) > .002) requestAnimationFrame(step); else run = false;
            };
            addEventListener('mousemove', e => {
                if (root.dataset.motion === 'off' || root.classList.contains('is-mobile')) return;
                tx = e.clientX / innerWidth * 2 - 1; ty = e.clientY / innerHeight * 2 - 1;
                if (!run) { run = true; requestAnimationFrame(step); }
            }, { passive: true });
        })();
