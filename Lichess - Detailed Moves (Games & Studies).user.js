// ==UserScript==
// @name            Lichess - Detailed Moves (Games & Studies)
// @license         GPL-3.0-only
// @namespace       https://github.com/sealldeveloper/lichess-better-moves
// @contributionURL https://github.com/sealldeveloper/lichess-better-moves
// @version         1.31
// @description     Show brillant, excellent, great and book moves. (Detect analysis completion via loader ID disappearance)
// @author          Seall.DEV & Thomas Sihapnya (Modified by Víctor Iglesias for study pages)
// @require         https://greasyfork.org/scripts/47911-font-awesome-all-js/code/Font-awesome%20AllJs.js?version=275337
// @include         /^https\:\/\/lichess\.org\/[a-zA-Z0-9]{8,}/
// @include         /^https\:\/\/lichess\.org\/study\/.*/
// @grant           GM.xmlHttpRequest
// @grant           unsafeWindow
// @grant           GM_addStyle
// @inject-into     content
// ==/UserScript==
// ==OpenUserJS==
// @author          sealldeveloper
// ==/OpenUserJS==

(function() {
    'use strict';
    // --- Config ---
    const GOOD_MOVE_THRESOLD = 0.6;
    const EXCELLENT_MOVE_THRESOLD = 1.0;
    const BRILLANT_MOVE_THRESOLD = 2.0;
    const CHECKMATE_IN_X_MOVES_VALUE = 100;
    const PROCESSING_DEBOUNCE = 550;
    const WAIT_FOR_SUMMARY_TIMEOUT = 5000;
    const WAIT_FOR_SUMMARY_INTERVAL = 250;
    const ANALYSIS_INACTIVITY_TIMEOUT = 7000; // Fallback inactivity timeout
    const SHOW_SAN_NOT_FOUND_WARNINGS = false;
    const LOADER_ID = 'acpl-chart-container-loader'; // <-- Use ID now

    const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
    const SVG_INDICATOR_ATTRIBUTE = 'data-userscript-indicator'; // Para identificar nuestros indicadores

    const SVG_INDICATOR_DATA = {
        brilliant: { // !!
            bgColor: '#168226', // Hex directo del ejemplo d6
            pathD: 'M71.967 62.349h-9.75l-2.049-39.083h13.847zM60.004 76.032q0-3.77 2.049-5.244 2.048-1.557 4.998-1.557 2.867 0 4.916 1.557 2.048 1.475 2.048 5.244 0 3.605-2.048 5.244-2.049 1.556-4.916 1.556-2.95 0-4.998-1.556-2.049-1.64-2.049-5.244zM37.967 62.349h-9.75l-2.049-39.083h13.847zM26.004 76.032q0-3.77 2.049-5.244 2.048-1.557 4.998-1.557 2.867 0 4.916 1.557 2.048 1.475 2.048 5.244 0 3.605-2.048 5.244-2.049 1.556-4.916 1.556-2.95 0-4.998-1.556-2.049-1.64-2.049-5.244z'
        },
        good: { // ! (Excelente)
            bgColor: '#22ac38', // Hex directo del ejemplo c5
            pathD: 'M54.967 62.349h-9.75l-2.049-39.083h13.847zM43.004 76.032q0-3.77 2.049-5.244 2.048-1.557 4.998-1.557 2.867 0 4.916 1.557 2.048 1.475 2.048 5.244 0 3.605-2.048 5.244-2.049 1.556-4.916 1.556-2.95 0-4.998-1.556-2.049-1.64-2.049-5.244z'
        },
        interesting: { // ?! (Buena)
            bgColor: '#ea45d8', // Hex directo del ejemplo e6
            pathD: 'M60.823 58.9q0-4.098 1.72-6.883 1.721-2.786 5.9-5.818 3.687-2.622 5.243-4.506 1.64-1.966 1.64-4.588t-1.967-3.933q-1.885-1.393-5.326-1.393t-6.8 1.065q-3.36 1.065-6.883 2.868l-4.343-8.767q4.015-2.212 8.685-3.605 4.67-1.393 10.242-1.393 8.521 0 13.192 4.097 4.752 4.096 4.752 10.405 0 3.36-1.065 5.818-1.066 2.458-3.196 4.588-2.13 2.048-5.326 4.424-2.376 1.72-3.687 2.95-1.31 1.229-1.802 2.376-.41 1.147-.41 2.868v2.376h-10.57zm-1.311 16.632q0-3.77 2.048-5.244 2.049-1.557 4.998-1.557 2.868 0 4.916 1.557 2.049 1.475 2.049 5.244 0 3.605-2.049 5.244-2.048 1.556-4.916 1.556-2.95 0-4.998-1.556-2.048-1.64-2.048-5.244zM36.967 61.849h-9.75l-2.049-39.083h13.847zM25.004 75.532q0-3.77 2.049-5.244 2.048-1.557 4.998-1.557 2.867 0 4.916 1.557 2.048 1.475 2.048 5.244 0 3.605-2.048 5.244-2.049 1.556-4.916 1.556-2.95 0-4.998-1.556-2.049-1.64-2.049-5.244z'
        },
        book: {
            bgColor: '#a88865', // Mantener este (o usar var(--c-book, #a88865))
            pathD: null // Usaremos foreignObject
        }
    };

    // --- Globals ---
    let currentEcoCodes = null;
    let observer = null;
    let analysisCompletionTimer = null;
    let processingDebounceTimer = null;
    let isProcessing = false;
    let observerTargetNode = null;
    let observerConfig = { childList: true, subtree: true, characterData: true };
    let currentMovesData = { white: {'book':0,'good':0,'excellent':0,'brillant':0}, black: {'book':0,'good':0,'excellent':0,'brillant':0} };
    let processedNodesForBook = new Set();

    function addCustomCss() {
        // Usamos los colores que tenías en los spans, o puedes ajustarlos
        // Añadimos !important por si acaso Lichess tiene estilos conflictivos
        const css = `
            .tview2 move.brilliant {
                color: #21c43a !important; /* Verde brillante */
            }
            .tview2 move.good { /* Clase para '!' (Excelente) */
                color: #629924 !important; /* Verde excelente */
            }
            .tview2 move.interesting { /* Clase para '!?' (Buena) */
                color: #f075e1 !important; /* Rosa */
            }

            /* Estilo para los glyphs que añadimos */
            .tview2 move.brilliant > glyph,
            .tview2 move.good > glyph,
            .tview2 move.interesting > glyph {
                font-weight: bold;
                margin-left: 3px; /* Pequeño espacio entre SAN y glyph */
                display: inline-block; /* Asegura buen comportamiento */
                color: inherit; /* Hereda el color del elemento 'move' padre */
                /* Puedes añadir más estilos si quieres, como font-size */
            }
        `;
        GM_addStyle(css);
        console.log("Custom CSS for move types injected.");
    }

    // --- Util ---
    function waitForElement(selector, callback, timeout = WAIT_FOR_SUMMARY_TIMEOUT, interval = WAIT_FOR_SUMMARY_INTERVAL) {
        const startTime = Date.now();
        let elementFound = false;
        const timer = setInterval(() => {
            if (!isProcessing || elementFound) { clearInterval(timer); return; }
            const element = document.querySelector(selector);
            if (element) {
                elementFound = true; clearInterval(timer);
                if(isProcessing) callback(element);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(timer);
                console.warn(`Timed out waiting for element "${selector}".`);
                if (isProcessing) finishProcessing(false);
            }
        }, interval);
    }

    // --- Observer ---
    function startObserverObservation() {
        if (observer && observerTargetNode) {
             try { observer.observe(observerTargetNode, observerConfig); console.log("Observer watching for changes..."); }
             catch (e) { console.error("Error starting observer.", e); }
        } else if (!observerTargetNode) { console.warn("Cannot start observer, target node not set."); }
    }

    // --- Core ---
    function loadEcoCodesApi(callback) {
        if (currentEcoCodes !== null) { callback(); return; }
        console.log('Loading ECO codes...');
        const ecoCodesApiUrl = 'https://github.com/sealldeveloper/lichess-detailed-moves/raw/main/data/eco.json';
        GM.xmlHttpRequest({
            method: "GET", url: ecoCodesApiUrl,
            onload: function(response) {
                let codes = [];
                try { codes = JSON.parse(response.responseText); console.log(`ECO codes loaded (${codes?.length || 0}).`); }
                catch (e) { console.error('Error parsing ECO codes.', e); codes = []; }
                finally { currentEcoCodes = codes; callback(); }
            },
            onerror: function(err) { console.error('Error fetching ECO codes.', err); currentEcoCodes = []; callback(); }
        });
    }

    function checkColor(index) { return (index % 2 === 0) ? "white" : "black"; }

    function triggerProcessing(reason = "Unknown") { // Add reason for clarity
        clearTimeout(processingDebounceTimer);
        processingDebounceTimer = setTimeout(() => {
            console.log(`Processing triggered by: ${reason}. Running after debounce...`);
            loadEcoCodesApi(processMovesAndSummary);
        }, PROCESSING_DEBOUNCE);
    }

    function processMovesAndSummary() {
        if (isProcessing) { console.log("Already processing, skipping trigger."); return; }
        isProcessing = true;
        console.log('Processing moves and summary...');

        if (currentEcoCodes === null || !Array.isArray(currentEcoCodes)) {
            console.error("ECO codes not ready! Aborting."); finishProcessing(false); return;
        }

        currentMovesData = { white: {'book':0,'good':0,'excellent':0,'brillant':0}, black: {'book':0,'good':0,'excellent':0,'brillant':0} };
        processedNodesForBook.clear();

        const potentialContainers = document.querySelectorAll('.analyse__moves .tview2-column, .gamebook .tview2-column, div.tview2.tview2-column');
        let moveContainer = null;
        for (let container of potentialContainers) { if (container.querySelector('move')) { moveContainer = container; break; } }
        if (!moveContainer) { console.warn('No move container found during processing.'); finishProcessing(false); return; }

        const domMoves = moveContainer.querySelectorAll('move');
        if (!domMoves || domMoves.length === 0) { console.warn('No moves found during processing.'); finishProcessing(false); return; }

        // --- Enhanced Cleanup ---
        domMoves.forEach(domMove => {
            // 1. Remove classes added by this script
            domMove.classList.remove('brilliant', 'good', 'interesting');

            // --- NEW: Remove data attribute marker ---
            domMove.removeAttribute('data-is-book');
            // --- END NEW ---

            // 2. Remove glyphs added by this script (check title for specificity)
            const existingGlyph = domMove.querySelector('glyph');
            if (existingGlyph && ['Brilliant move', 'Good move', 'Interesting move'].includes(existingGlyph.title)) {
                existingGlyph.remove();
            }

            // 3. Original SAN cleanup (handles old colored spans and trailing symbols in SAN text)
            const sanNode = domMove.querySelector('san');
            if (sanNode) {
                // Remove old colored span if exists (from previous script versions)
                const addedSpan = sanNode.querySelector('span[style^="color"]');
                if (addedSpan) {
                     sanNode.textContent = addedSpan.textContent.replace(/[!?]$|!!$/, '').trim(); // Use textContent
                } else {
                     // If no span, still clean trailing symbols from SAN text itself
                     sanNode.textContent = sanNode.textContent.replace(/[!?]$|!!$/, '').trim(); // Use textContent
                }
                // Note: The book move logic handles its own span/icon/title separately
            }

            // 4. Original title removal (Book move logic re-adds its title later if applicable)
            // Avoid removing titles from Lichess's own annotations like Mistake/Blunder
             const lichessGlyph = domMove.querySelector('glyph'); // Re-check after potential removal above
             const isLichessAnnotation = lichessGlyph && (lichessGlyph.title.includes('Mistake') || lichessGlyph.title.includes('Blunder') || lichessGlyph.title.includes('Inaccuracy'));
             const isBookMove = domMove.querySelector('san .book-icon-wrapper'); // Check if book logic might add title

            if (!isLichessAnnotation && !isBookMove) {
                 domMove.removeAttribute('title');
            }
        });
        // --- End of Cleanup ---

        const summaryContainer = document.querySelector('.advice-summary');
        if(summaryContainer) { summaryContainer.querySelectorAll('.custom-move-stat').forEach(el => el.remove()); }

        let moves = [];
        let previousEval = { value: 0 };

        domMoves.forEach((domMove, domIndex) => {
            if (domMove.classList.contains('empty')) return;
            const sanNode = domMove.querySelector('san');
            if (sanNode) {
                // Get the clean SAN text *after* cleanup
                const currentSanText = sanNode.textContent.trim(); // Use textContent which is now clean
                const isCheckmatingMove = currentSanText.endsWith('#'); // Check clean text
                moves.push(currentSanText); // Add clean text to moves array
                let currentMoveIndex = moves.length - 1;
                let currentColor = checkColor(currentMoveIndex);
                domMove.dataset.moveColor = currentColor; // Añade el color como atributo data-*
                domMove.dataset.san = currentSanText; // Añade la notación SAN como atributo data-*
                let isBookMove = !!sanNode.querySelector('i.fa-book'); // Check if book icon exists from potential previous run or Lichess

                // Handle opening moves (Remains the same, uses span+icon)
                if (!isBookMove && currentEcoCodes.length > 0) {
                    let currentPgn = createPgnMoves(moves);
                    let foundOpening = currentEcoCodes.find(eco => eco.moves.toLowerCase().trim() == currentPgn.toLowerCase().trim());
                    if (foundOpening) {
                        // Pass currentSanText instead of originalMoveHTML which might contain old spans
                        handleOpeningMoveStrict(sanNode, currentSanText, foundOpening, currentColor, domMove);
                        isBookMove = true; // Mark as book after handling
                    }
                } else if (isBookMove && !processedNodesForBook.has(domMove)) {
                     domMove.setAttribute('data-is-book', 'true');
                     currentMovesData[currentColor].book++;
                     processedNodesForBook.add(domMove);
                }

                // Evaluation Logic - Modified Annotation Part
                let currentEval = { value: previousEval.value };
                const evalNode = domMove.querySelector('eval');

                if (!isBookMove && !isCheckmatingMove) {
                    if (evalNode) {
                        let evalText = evalNode.innerHTML.trim();
                        if (evalText.startsWith('#')) { currentEval.value = (currentColor === 'white') ? -CHECKMATE_IN_X_MOVES_VALUE : CHECKMATE_IN_X_MOVES_VALUE; }
                        else { let parsedVal = parseFloat(evalText); currentEval.value = isNaN(parsedVal) ? 0 : parsedVal; }

                        if (currentMoveIndex > 0) {
                            let delta = currentEval.value - previousEval.value;
                            let annotationAdded = false;

                            let currentSanText = sanNode.textContent.trim(); // Get SAN for logging

                            // --- NEW: Define constants for classes, titles, and symbols ---
                            const brilliantClass = 'brilliant';
                            const brilliantTitle = 'Brilliant move';
                            const brilliantSymbol = '!!';
                            const excellentClass = 'good'; // Using 'good' class for '!' as per your example
                            const excellentTitle = 'Good move'; // Using 'Good move' title for '!'
                            const excellentSymbol = '!';
                            const goodClass = 'interesting'; // Using 'interesting' class for '!?' as per your example
                            const goodTitle = 'Interesting move';// Using 'Interesting move' title for '!?'
                            const goodSymbol = '!?';

                            // --- Helper function to add class and glyph ---
                            function addGlyphAnnotation(moveElement, sanElement, className, glyphTitle, glyphSymbol) {
                                moveElement.classList.add(className);
                                const glyph = document.createElement('glyph');
                                glyph.title = glyphTitle;
                                glyph.textContent = glyphSymbol;
                                // Insert the glyph *after* the SAN tag
                                sanElement.parentNode.insertBefore(glyph, sanElement.nextSibling);
                            }

                            if (currentColor === 'white') {
                                if (delta >= BRILLANT_MOVE_THRESOLD) {
                                    // OLD: sanNode.innerHTML = `<span style="color: #1baca6;">${currentSanText}!!</span>`;
                                    addGlyphAnnotation(domMove, sanNode, brilliantClass, brilliantTitle, brilliantSymbol);
                                    currentMovesData.white.brillant++;
                                    annotationAdded = true;
                                }
                                if (!annotationAdded && delta >= EXCELLENT_MOVE_THRESOLD) {
                                    // OLD: sanNode.innerHTML = `<span style="color: #96bc4b;">${currentSanText}!</span>`;
                                    addGlyphAnnotation(domMove, sanNode, excellentClass, excellentTitle, excellentSymbol);
                                    currentMovesData.white.excellent++;
                                    annotationAdded = true;
                                }
                                if (!annotationAdded && delta >= GOOD_MOVE_THRESOLD) {
                                    // OLD: sanNode.innerHTML = `<span style="color: #b2f196;">${currentSanText}!?</span>`;
                                    addGlyphAnnotation(domMove, sanNode, goodClass, goodTitle, goodSymbol);
                                    currentMovesData.white.good++;
                                    annotationAdded = true;
                                }
                            } else { // Black
                                if (delta <= -BRILLANT_MOVE_THRESOLD) {
                                    // OLD: sanNode.innerHTML = `<span style="color: #1baca6;">${currentSanText}!!</span>`;
                                    addGlyphAnnotation(domMove, sanNode, brilliantClass, brilliantTitle, brilliantSymbol);
                                    currentMovesData.black.brillant++;
                                    annotationAdded = true;
                                }
                                if (!annotationAdded && delta <= -EXCELLENT_MOVE_THRESOLD) {
                                    // OLD: sanNode.innerHTML = `<span style="color: #96bc4b;">${currentSanText}!</span>`;
                                    addGlyphAnnotation(domMove, sanNode, excellentClass, excellentTitle, excellentSymbol);
                                    currentMovesData.black.excellent++;
                                    annotationAdded = true;
                                }
                                if (!annotationAdded && delta <= -GOOD_MOVE_THRESOLD) {
                                    // OLD: sanNode.innerHTML = `<span style="color: #b2f196;">${currentSanText}!?</span>`;
                                    addGlyphAnnotation(domMove, sanNode, goodClass, goodTitle, goodSymbol);
                                    currentMovesData.black.good++;
                                    annotationAdded = true;
                                }
                            }
                            // If no annotation was added, the sanNode.textContent remains the clean move notation.
                        }
                    }
                } else { // Skipped eval annotation (Book or Checkmate)
                    if (evalNode) { // Still need to parse eval for the *next* move's comparison
                         let evalText = evalNode.innerHTML.trim();
                         if (evalText.startsWith('#')) { currentEval.value = (currentColor === 'white') ? -CHECKMATE_IN_X_MOVES_VALUE : CHECKMATE_IN_X_MOVES_VALUE; }
                         else { let parsedVal = parseFloat(evalText); currentEval.value = isNaN(parsedVal) ? 0 : parsedVal; }
                    }
                }
                // Update previous state
                previousEval = currentEval;

            } else if (SHOW_SAN_NOT_FOUND_WARNINGS) { console.warn(`No <san> tag found.`); }
        }); // End domMoves loop

        console.log('Move processing finished.');
        waitForElement('.advice-summary', (summaryContainer) => showDataInTable(summaryContainer));

    } // End processMovesAndSummary

    function handleOpeningMoveStrict(sanNode, originalMoveText, opening, currentColor, domMove) {
        if (sanNode.querySelector('.book-icon-wrapper')) return;
        const titleText = opening.name;
        const textContent = originalMoveText;
        sanNode.innerHTML = `<span style="color: #a88865;">${textContent}<span class="book-icon-wrapper" style="display: inline-block;"><i class="fas fa-book" style="font-size: 0.7em; margin-left: 3px;" title="${titleText}"></i></span></span>`;
        if (domMove) {
            domMove.title = titleText;
            domMove.setAttribute('data-is-book', 'true');
            if (!processedNodesForBook.has(domMove)) { currentMovesData[currentColor].book++; processedNodesForBook.add(domMove); }
        }
    }

    function createPgnMoves(movesArray) {
        let pgn = '';
        movesArray.forEach((move, index) => {
            const cleanMove = move.replace(/<[^>]*>/g, '');
            if (checkColor(index) === "white") { pgn += `${Math.floor(index / 2) + 1}. ${cleanMove}`; }
            else { pgn += ` ${cleanMove} `; }
        });
        return pgn.trim();
    }

    function showDataInTable(summaryContainer) {
        console.log('Updating summary table...'); // Log mantenido
        if (!summaryContainer || !isProcessing) { /* ... */ return; }
        const summarySides = summaryContainer.querySelectorAll('.advice-summary__side');
        if (summarySides.length < 2) { /* ... */ return; }
        const whiteTable = Array.from(summarySides).find(side => side.querySelector('.color-icon.white'));
        const blackTable = Array.from(summarySides).find(side => side.querySelector('.color-icon.black'));
        if (!whiteTable || !blackTable) { /* ... */ return; }

        // --- Función dataPoint INTERNA ---
        // (La función dataPoint en sí misma no necesita cambios,
        // ya que acepta el string de color y lo aplica)
        function dataPoint(colour, symbol, data, text, table, coloured /*, _className - No usado*/) {
            let beforeNode = null;
            const childNodes = Array.from(table.childNodes);
            const insertBeforeTerms = [
                'imprecisiones', 'Imprecisiones', 'imprecisión', 'Imprecisión', 'inaccuracy', 'Inaccuracies', 'inaccuracy', 'Inaccuracy',
                'Error', 'Errores', 'Mistake', 'mistake', 'Mistakes', 'mistakes',
                'Errores graves', 'Blunder', 'blunder', 'Blunders', 'blunders',
                'Pérdida promedio', 'average centipawn loss',
                'Precisión', 'Accuracy'
            ];
            for (const term of insertBeforeTerms) {
                 const potentialNode = childNodes.find(node => node.nodeType === Node.ELEMENT_NODE && (node.textContent || '').toLowerCase().includes(term.toLowerCase()));
                 if (potentialNode?.offsetParent) { beforeNode = potentialNode; break; }
            }
            if (!beforeNode) {
                beforeNode = table.querySelector('.advice-summary__acpl') || table.querySelector('.advice-summary__accuracy');
            }

            const div = document.createElement('div');
            div.classList.add('advice-summary__error', 'symbol', 'custom-move-stat'); // Añadimos clase para posible limpieza futura

            let simpleClassNameForClick = '';
            if (symbol === '!!') simpleClassNameForClick = 'brilliant';
            else if (symbol === '!') simpleClassNameForClick = 'good';
            else if (symbol === '!?') simpleClassNameForClick = 'interesting';
            else if (symbol === 'Book') simpleClassNameForClick = 'book';

            if (simpleClassNameForClick) {
                div.classList.add(simpleClassNameForClick);
                div.style.cursor = (data > 0) ? 'pointer' : 'text';
            }

            // --- Aplicar el Color al Texto del Resumen ---
            // Usamos setProperty que es más robusto, especialmente si en el futuro
            // decidiéramos volver a usar variables CSS aquí.
            if (data > 0 && coloured) {
                 div.style.setProperty('color', coloured);
            }
            // --- Fin Aplicar Color ---

            div.setAttribute('data-color', colour);
            div.setAttribute('data-symbol', symbol);
            const strong = document.createElement('strong'); strong.textContent = data;
            div.appendChild(strong);
            div.appendChild(document.createTextNode(text));

            if (beforeNode) { table.insertBefore(div, beforeNode); }
            else { table.appendChild(div); }
        }
        // --- Fin función dataPoint ---


        // --- LLAMADAS MODIFICADAS ---
        // Usa los códigos hexadecimales EXACTOS de SVG_INDICATOR_DATA
        dataPoint('white','!!',currentMovesData.white.brillant,'Brillantes',whiteTable, SVG_INDICATOR_DATA.brilliant.bgColor); // Brillante (!!)
        dataPoint('white','!',currentMovesData.white.excellent,'Excelentes',whiteTable, SVG_INDICATOR_DATA.good.bgColor); // Excelente (!)
        dataPoint('white','!?',currentMovesData.white.good,'Buenas',whiteTable, SVG_INDICATOR_DATA.interesting.bgColor); // Buena (!?)
        dataPoint('white','Book',currentMovesData.white.book,'De libro',whiteTable, SVG_INDICATOR_DATA.book.bgColor); // Libro

        dataPoint('black','!!',currentMovesData.black.brillant,'Brillantes',blackTable, SVG_INDICATOR_DATA.brilliant.bgColor);
        dataPoint('black','!',currentMovesData.black.excellent,'Excelentes',blackTable, SVG_INDICATOR_DATA.good.bgColor);
        dataPoint('black','!?',currentMovesData.black.good,'Buenas',blackTable, SVG_INDICATOR_DATA.interesting.bgColor);
        dataPoint('black','Book',currentMovesData.black.book,'De libro',blackTable, SVG_INDICATOR_DATA.book.bgColor);
        // --- FIN LLAMADAS MODIFICADAS ---

        finishProcessing(true); // Finish successfully
    }

    function finishProcessing(success) {
        // console.log(`Processing finished ${success ? 'successfully' : 'unsuccessfully'}.`);
        if (isProcessing) { isProcessing = false; }
        // Observer remains active
    }

    // --- Board Indicator Functions ---

    const BOARD_INDICATOR_CLASS = 'userscript-move-indicator';

    // Función para limpiar indicadores previos del tablero
    // --- SVG Indicator Functions (V8) ---
    function clearBoardIndicators() {
        const svgContainer = document.querySelector('svg.cg-custom-svgs');
        if (svgContainer) {
            const indicators = svgContainer.querySelectorAll(`g[${SVG_INDICATOR_ATTRIBUTE}]`);
            // console.log(`SVG Clearing ${indicators.length} indicators...`); // Debug
            indicators.forEach(indicator => indicator.remove());
        }
    }

    // Función para obtener la casilla destino desde SAN (Simplificada)
    function getDestSquareFromSan(san, color) {
        if (!san) return null;

        // Casos especiales: Enroque
        if (san === 'O-O') return color === 'white' ? 'g1' : 'g8';
        if (san === 'O-O-O') return color === 'white' ? 'c1' : 'c8';

        // Quitar anotaciones (!!, !, !?, ?, ??), check (+), mate (#), promoción (=Q)
        const cleanedSan = san.replace(/[!?+#=][QRNB]?/g, '');

        // La casilla destino son los últimos 2 caracteres (si tiene al menos 2)
        if (cleanedSan.length >= 2) {
            return cleanedSan.slice(-2);
        }

        // Podría fallar para movimientos de peón muy cortos (e.g., "e4") si cleanedSan queda corto
        // o para casos muy raros. Una versión más robusta requeriría más lógica de parseo.
        // Si SAN es como "e4", cleanedSan es "e4", slice(-2) funciona.
        // Si SAN es como "a", (error o muy raro), fallará aquí.

        console.warn("Could not determine destination square from SAN:", san);
        return null;
    }

    // --- SVG Indicator Functions (V8.2 - Exact Colors & Local Shadow Def) ---
    function addBoardIndicator(square, type) { // 'square' es ej. "e5", 'type' es ej. "brilliant"
        const svgContainer = document.querySelector('svg.cg-custom-svgs');
        const boardWrap = document.querySelector('.cg-wrap');

        if (!svgContainer || !boardWrap) {
            console.warn("V8.2: Could not find cg-custom-svgs or cg-wrap container.");
            return;
        }

        const data = SVG_INDICATOR_DATA[type];
        if (!data) {
            console.warn(`V8.2: No SVG data found for type "${type}".`);
            return;
        }

        // --- Calcular coordenadas SVG (igual que V8.1) ---
        const file = square.charAt(0); const rank = square.charAt(1);
        const rankNum = parseInt(rank);
        if (isNaN(rankNum) || rankNum < 1 || rankNum > 8 || file < 'a' || file > 'h') { /*...*/ return; }
        const isBlackOrientation = boardWrap.classList.contains('orientation-black');
        let fileIndex, rowIndex;
        if (isBlackOrientation) {
            fileIndex = 'h'.charCodeAt(0) - file.charCodeAt(0); rowIndex = rankNum - 1;
        } else {
            fileIndex = file.charCodeAt(0) - 'a'.charCodeAt(0); rowIndex = 8 - rankNum;
        }
        const tx = -3.5 + fileIndex; const ty = -3.5 + rowIndex;
        // --- FIN CÁLCULO ---

        // Crear elementos SVG
        const gOuter = document.createElementNS(SVG_NAMESPACE, 'g');
        gOuter.setAttribute('transform', `translate(${tx},${ty})`);
        gOuter.setAttribute(SVG_INDICATOR_ATTRIBUTE, 'true');

        const svgInner = document.createElementNS(SVG_NAMESPACE, 'svg');
        svgInner.setAttribute('width', '1'); svgInner.setAttribute('height', '1');
        svgInner.setAttribute('viewBox', '0 0 100 100');

        // --- AÑADIR DEFINICIÓN DE FILTRO LOCALMENTE ---
        const defs = document.createElementNS(SVG_NAMESPACE, 'defs');
        const filter = document.createElementNS(SVG_NAMESPACE, 'filter');
        filter.setAttribute('id', 'shadow'); // Usar el mismo ID que Lichess
        const feDropShadow = document.createElementNS(SVG_NAMESPACE, 'feDropShadow');
        feDropShadow.setAttribute('dx', '4'); // Valores copiados de Lichess
        feDropShadow.setAttribute('dy', '7');
        feDropShadow.setAttribute('stdDeviation', '5');
        feDropShadow.setAttribute('flood-opacity', '0.5');

        filter.appendChild(feDropShadow);
        defs.appendChild(filter);
        svgInner.appendChild(defs); // Añadir <defs> al <svg> interno
        // --- FIN AÑADIR DEFINICIÓN ---

        const gPos = document.createElementNS(SVG_NAMESPACE, 'g');
        gPos.setAttribute('transform', 'translate(71 -12) scale(0.4)');

        const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
        // Usar el color hex directo y referenciar el filtro local
        circle.setAttribute('style', `fill:${data.bgColor};filter:url(#shadow)`);
        circle.setAttribute('cx', '50'); circle.setAttribute('cy', '50'); circle.setAttribute('r', '50');

        gPos.appendChild(circle);

        if (type === 'book') {
            // ... (código del foreignObject para el libro - SIN CAMBIOS DESDE V8.1) ...
            const foreignObj = document.createElementNS(SVG_NAMESPACE, 'foreignObject');
            foreignObj.setAttribute('x', '0'); foreignObj.setAttribute('y', '0');
            foreignObj.setAttribute('width', '100'); foreignObj.setAttribute('height', '100');
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:white;';
            const faIcon = document.createElement('i');
            faIcon.className = 'fas fa-book';
            faIcon.style.cssText = 'font-size:45px;line-height:1;'; // Ajusta este tamaño si es necesario
            wrapper.appendChild(faIcon);
            foreignObj.appendChild(wrapper);
            gPos.appendChild(foreignObj);
        } else if (data.pathD) {
            // ... (código del path para !!, !, !? - SIN CAMBIOS DESDE V8.1) ...
            const path = document.createElementNS(SVG_NAMESPACE, 'path');
            path.setAttribute('fill', '#fff');
            path.setAttribute('d', data.pathD);
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            gPos.appendChild(path);
        }

        svgInner.appendChild(gPos);
        gOuter.appendChild(svgInner);

        svgContainer.appendChild(gOuter);
        // console.log(`V8.2: Added SVG indicator (${type}) for ${square} at translate(${tx}, ${ty})`);
    }

    // --- NEW: Function to handle sequential navigation clicks in summary ---
    // --- Function to handle sequential navigation clicks in summary (v3 - Fix current index & color filtering) ---
        // --- Function to handle sequential navigation clicks in summary (v4 - Add Book Move Support) ---
    function setupSummaryClickNavigation() {
        console.log("Setting up summary click navigation listeners..."); // <-- Log útil mantenido

        const mainContainer = document.querySelector('main.analyse, main.study') || document.body;

         mainContainer.addEventListener('click', function(event) {
            const clickedSummaryItem = event.target.closest('.advice-summary__error.symbol');
            if (!clickedSummaryItem) return;

            // Determine Move Class
            let moveClass = '';
            if (clickedSummaryItem.classList.contains('brilliant')) moveClass = 'brilliant';
            else if (clickedSummaryItem.classList.contains('good')) moveClass = 'good';
            else if (clickedSummaryItem.classList.contains('interesting')) moveClass = 'interesting';
            else if (clickedSummaryItem.classList.contains('book')) moveClass = 'book';

            if (!moveClass) return; // Not a class we handle

            // Get Target Color
             const targetColor = clickedSummaryItem.dataset.color;
             if (!targetColor) {
                 // console.warn("Could not determine target color from clicked summary item:", clickedSummaryItem); // Comentado/Eliminado
                 return;
             }

            // Stop Lichess's default handler
            event.stopPropagation();

            // Find Containers and All Moves
            const moveListContainer = document.querySelector('.analyse__moves .tview2-column, .gamebook .tview2-column, div.tview2.tview2-column');
             if (!moveListContainer) { console.error("Move list container not found."); return; } // <-- Error mantenido
             const allMoveNodes = moveListContainer.querySelectorAll('move:not(.empty)');
             const allMoveElements = Array.from(allMoveNodes);
             // console.log(`Found ${allMoveElements.length} total moves.`); // Comentado/Eliminado

            // Find Current Move
            const currentMoveNode = moveListContainer.querySelector('move.active');
            let currentIndex = -1;
            if (currentMoveNode) {
                 currentIndex = allMoveElements.indexOf(currentMoveNode);
                 // console.log(`Current move index: ${currentIndex}`, currentMoveNode); // Comentado/Eliminado
            } else {
                 // console.log("Current move index: -1 (No active move found)"); // Comentado/Eliminado
            }

            // Find Potential Relevant Moves using the CORRECT SELECTOR
            let selector = '';
            if (moveClass === 'book') {
                 selector = 'move[data-is-book="true"]:not(.empty)';
            } else {
                 selector = `move.${moveClass}:not(.empty)`;
            }
            // console.log("Using selector:", selector); // Comentado/Eliminado
            const allPotentialRelevantNodes = moveListContainer.querySelectorAll(selector);
            // console.log(`Found ${allPotentialRelevantNodes.length} potential moves with selector:`, allPotentialRelevantNodes); // Comentado/Eliminado

            // --- Filter by Color (Using Stored Data Attribute) ---
            const relevantMoveNodes = [];
            // console.log(`Filtering for color "${targetColor}"...`); // Comentado/Eliminado
            for (const node of allPotentialRelevantNodes) {
                const nodeIndex = allMoveElements.indexOf(node);
                if (nodeIndex === -1) continue;

                // Read the stored color directly from the element
                const nodeColor = node.dataset.moveColor;

                // --- Logs eliminados de la comprobación ---

                if (nodeColor === targetColor) {
                    relevantMoveNodes.push(node);
                }
            }
             // console.log(`Found ${relevantMoveNodes.length} relevant moves after color filtering:`, relevantMoveNodes); // Comentado/Eliminado
            // --- End Filter ---


            // Navigation Logic
            if (relevantMoveNodes.length === 0) {
                 // console.log("No relevant moves found after filtering. Aborting navigation."); // Comentado/Eliminado
                 return;
             }

            let nextTargetNode = null;
             let foundNext = false;
             // console.log("Starting search for next move after index:", currentIndex); // Comentado/Eliminado
            for (const node of relevantMoveNodes) {
                const nodeIndex = allMoveElements.indexOf(node);
                if (nodeIndex > currentIndex) {
                    nextTargetNode = node;
                     foundNext = true;
                    break;
                }
            }
             if (!foundNext) {
                 // console.log("Did not find a move *after* current index. Wrapping around."); // Comentado/Eliminado
                 nextTargetNode = relevantMoveNodes[0]; // Wrap around
             }

            // console.log("Final target node:", nextTargetNode); // Comentado/Eliminado

            // Dispatch Event
            if (nextTargetNode) {
                try {
                    // console.log("Attempting to dispatch mousedown event..."); // Comentado/Eliminado
                    const mouseDownEvent = new MouseEvent('mousedown', {
                        bubbles: true, cancelable: true, view: unsafeWindow
                    });
                    nextTargetNode.dispatchEvent(mouseDownEvent);
                    // console.log("Mousedown event dispatch result:", dispatchResult); // Comentado/Eliminado
                } catch (e) {
                    console.error("Error dispatching mousedown event:", e); // <-- Error mantenido
                    try { // Fallback to click
                         nextTargetNode.click();
                    } catch (e2) {
                         console.error("Fallback .click() also failed:", e2); // <-- Error mantenido
                    }
                }
            } else {
                 console.warn("Could not determine target move node after filtering and logic."); // <-- Warning mantenido
            }
        }); // End event listener

        console.log("Summary click navigation listeners are active."); // <-- Log útil mantenido
    } // End setupSummaryClickNavigation function
    // --- Init & Event Handling ---
    // No automatic run on load needed; observer handles trigger

    // --- Observer for Active Move on Board ---
    let moveListObserver = null;

    function setupMoveListObserver() {
        const moveListContainer = document.querySelector('.analyse__moves .tview2-column, .gamebook .tview2-column, div.tview2.tview2-column');
        if (!moveListContainer) { /* ... */ return; }

        const observerCallback = (mutationsList, observer) => {
            for (const mutation of mutationsList) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'class' && mutation.target.tagName === 'MOVE') {
                    const moveElement = mutation.target;

                    if (moveElement.classList.contains('active')) {
                        // console.log("Active move detected:", moveElement.dataset.san);

                        // 1. Limpiar indicadores SVG inmediatamente
                        clearBoardIndicators(); // Llama a la nueva función SVG

                        let moveType = null;

                        // 2. Determinar si es una jugada especial
                        if (moveElement.classList.contains('brilliant')) { moveType = 'brilliant'; }
                        else if (moveElement.classList.contains('good')) { moveType = 'good'; }
                        else if (moveElement.classList.contains('interesting')) { moveType = 'interesting'; }
                        else if (moveElement.matches('[data-is-book="true"]')) { moveType = 'book'; }

                        // 3. Si ES una jugada especial, añadir el indicador SVG
                        if (moveType) {
                            const san = moveElement.dataset.san;
                            const color = moveElement.dataset.moveColor; // Color aún necesario para getDestSquareFromSan (enroque)
                            if (san && color) {
                                const destSquareAlg = getDestSquareFromSan(san, color);
                                if (destSquareAlg) {
                                    // --- LLAMAR DIRECTAMENTE (SIN setTimeout) ---
                                    addBoardIndicator(destSquareAlg, moveType); // Llama a la nueva función SVG
                                    // --- FIN LLAMADA DIRECTA ---
                                }
                            } else {
                                console.warn("Active move lacks SAN or Color data:", moveElement);
                            }
                        }
                        // else { // No es especial, la limpieza ya se hizo
                        //    console.log("Active move not special type. Board already cleared.");
                        //}
                        return; // Salir tras procesar la activa
                    }
                }
            }
        };

        moveListObserver = new MutationObserver(observerCallback);
        const config = { attributes: true, subtree: true, attributeFilter: ['class'] };
        moveListObserver.observe(moveListContainer, config);
        console.log("Move list observer V8 (SVG Indicators) is active.");
    }

    // --- Observer Setup ---
    function setupObserver() {
        observerTargetNode = document.querySelector('main.analyse, main.study');
        if (!observerTargetNode) { console.warn("Could not find main container for Observer."); return; }

        const observerCallback = (mutationsList, obs) => {
            if (isProcessing) return; // Ignore mutations during processing

            let loaderRemoved = false;
            let evalChanged = false;

            for(const mutation of mutationsList) {
                // Check for loader removal FIRST
                if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
                    if (Array.from(mutation.removedNodes).some(node => node.nodeType === Node.ELEMENT_NODE && node.id === LOADER_ID)) {
                        loaderRemoved = true;
                        break; // Prioritize this signal
                    }
                }
                // Check for eval text changes if loader wasn't removed in this batch
                 if (!loaderRemoved && mutation.type === 'characterData' && mutation.target.parentElement?.tagName === 'EVAL'){
                    evalChanged = true;
                 }
            }

            // --- Triggering Logic ---
            if (loaderRemoved) {
                // Analysis likely finished based on loader removal
                console.log(`Analysis loader #${LOADER_ID} removed. Debouncing processing trigger...`);
                clearTimeout(analysisCompletionTimer); // Clear inactivity timer
                triggerProcessing("Loader Removed"); // Trigger processing via debounce
            } else if (evalChanged) {
                // Analysis is actively running, reset inactivity timer (fallback)
                // console.log("Eval change detected. Resetting inactivity timer.");
                clearTimeout(analysisCompletionTimer);
                clearTimeout(processingDebounceTimer); // Cancel pending processing if activity resumes
                analysisCompletionTimer = setTimeout(() => {
                    console.log(`Analysis inactivity detected (${ANALYSIS_INACTIVITY_TIMEOUT}ms). Triggering processing (fallback).`);
                    triggerProcessing("Inactivity Fallback"); // Trigger processing via debounce
                }, ANALYSIS_INACTIVITY_TIMEOUT);
            }
        };
        observer = new MutationObserver(observerCallback);
        console.log("MutationObserver created.");
        startObserverObservation(); // Start observing immediately
    }

    // --- Entry Point ---
    window.addEventListener('load', () => {
        console.log("Lichess Detailed Moves script running (v1.31 - Loader ID Detection)...");
        addCustomCss();
        loadEcoCodesApi(() => {
             console.log("ECO codes pre-loaded. Setting up observer.");
             setupObserver();
             setupSummaryClickNavigation();
             setupMoveListObserver(); // Activar el observer de la lista de jugadas
             console.log("Waiting for analysis completion (loader removal or inactivity) to trigger processing...");
             // Optional: Initial check if loader is *already* missing and evals exist
             setTimeout(() => {
                if (!document.getElementById(LOADER_ID) && document.querySelector('move:not(.empty) eval')) {
                    console.log("Loader not present and evals found on load. Triggering initial processing check.");
                    triggerProcessing("Initial Load Check");
                } else {
                    console.log("Initial check: Loader present or no evals found. Waiting for observer.");
                }
             }, 1000); // Wait 1s after setup before this check
        });
    }, false);

})();