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
        console.log('Updating summary table (Restoring colors, keeping simplified HTML)...'); // Log actualizado
        if (!summaryContainer || !isProcessing) { console.warn(`Invalid summary or processing flag false.`); finishProcessing(false); return; }
        const summarySides = summaryContainer.querySelectorAll('.advice-summary__side');
        if (summarySides.length < 2) { console.warn(`Less than 2 summary sides.`); finishProcessing(false); return; }
        const whiteTable = Array.from(summarySides).find(side => side.querySelector('.color-icon.white'));
        const blackTable = Array.from(summarySides).find(side => side.querySelector('.color-icon.black'));
        if (!whiteTable || !blackTable) { console.warn('Could not ID white/black summary sides.'); finishProcessing(false); return; }

        // --- Modified dataPoint function (restoring color application) ---
        function dataPoint(colour, symbol, data, text, table, coloured, _className) { // Volvemos a usar 'coloured', ignoramos '_className'
            let beforeNode = null;
            const childNodes = Array.from(table.childNodes);
            const insertBeforeTerms = [ /* ... (mismos términos que antes) ... */
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

            // --- Add classes mimicking Lichess structure ---
            div.classList.add('advice-summary__error', 'symbol');

            let simpleClassNameForClick = '';
            if (symbol === '!!') simpleClassNameForClick = 'brilliant';
            else if (symbol === '!') simpleClassNameForClick = 'good';
            else if (symbol === '!?') simpleClassNameForClick = 'interesting';
            else if (symbol === 'Book') simpleClassNameForClick = 'book';

            if (simpleClassNameForClick) {
                div.classList.add(simpleClassNameForClick); // Add the class ('brilliant', 'good', 'interesting', 'book')

                // --- Conditionally set cursor style ---
                if (data > 0) {
                    // Apply pointer if there are moves
                    div.style.cursor = 'pointer';
                } else {
                    // Explicitly set default cursor if there are no moves
                    // This overrides any potential CSS rule applying pointer based on the class
                    div.style.cursor = 'text';
                }
                // --- End cursor logic ---
            }
            // --- End class adjustments ---

            // --- Restore direct color styling for the summary text ---
            // Apply color if data exists and a color code was provided
            // This ensures the text in the summary has the intended color.
             if (data > 0 && coloured) {
                 div.style.color = coloured;
             }
            // --- End color restoration ---


            // Add attributes
            div.setAttribute('data-color', colour);
            div.setAttribute('data-symbol', symbol);

            // Add content
            const strong = document.createElement('strong'); strong.textContent = data;
            div.appendChild(strong);
            div.appendChild(document.createTextNode(text));

            // Insert into DOM
            if (beforeNode) {
                table.insertBefore(div, beforeNode);
            } else {
                table.appendChild(div);
            }
        }
        // --- End of modified dataPoint function ---


        // Calls - Pass the color parameter again
        dataPoint('white','!!',currentMovesData.white.brillant,'Brillantes',whiteTable,'#1baca6', 'stat-brilliant-w');
        dataPoint('white','!',currentMovesData.white.excellent,'Excelentes',whiteTable,'#96bc4b', 'stat-excellent-w');
        dataPoint('white','!?',currentMovesData.white.good,'Buenas',whiteTable,'#b2f196', 'stat-good-w');
        dataPoint('white','Book',currentMovesData.white.book,'De libro',whiteTable,'#a88865', 'stat-book-w');

        dataPoint('black','!!',currentMovesData.black.brillant,'Brillantes',blackTable,'#1baca6', 'stat-brilliant-b');
        dataPoint('black','!',currentMovesData.black.excellent,'Excelentes',blackTable,'#96bc4b', 'stat-excellent-b');
        dataPoint('black','!?',currentMovesData.black.good,'Buenas',blackTable,'#b2f196', 'stat-good-b');
        dataPoint('black','Book',currentMovesData.black.book,'De libro',blackTable,'#a88865', 'stat-book-b');

        finishProcessing(true); // Finish successfully
    }


    function finishProcessing(success) {
        // console.log(`Processing finished ${success ? 'successfully' : 'unsuccessfully'}.`);
        if (isProcessing) { isProcessing = false; }
        // Observer remains active
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