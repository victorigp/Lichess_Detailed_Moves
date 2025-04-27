// ==UserScript==
// @name            Lichess - Detailed Moves (Games & Studies)
// @license         GPL-3.0-only
// @namespace       https://github.com/sealldeveloper/lichess-better-moves
// @contributionURL https://github.com/sealldeveloper/lichess-better-moves
// @version         1.29
// @description     Show brillant, excellent, great and book moves. (Detect analysis completion via loader ID disappearance)
// @author          Seall.DEV & Thomas Sihapnya (Modified by Víctor Iglesias for study pages)
// @require         https://greasyfork.org/scripts/47911-font-awesome-all-js/code/Font-awesome%20AllJs.js?version=275337
// @include         /^https\:\/\/lichess\.org\/[a-zA-Z0-9]{8,}/
// @include         /^https\:\/\/lichess\.org\/study\/.*/
// @grant           GM.xmlHttpRequest
// @grant           unsafeWindow
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

        // Clear previous annotations
        domMoves.forEach(domMove => {
            const sanNode = domMove.querySelector('san');
            if (sanNode) {
                const addedSpan = sanNode.querySelector('span[style^="color"], span.book-icon-wrapper');
                if (addedSpan) { sanNode.innerHTML = addedSpan.textContent.replace(/[!?]$|!!$/, '').trim(); }
                else { sanNode.innerHTML = sanNode.innerHTML.replace(/[!?]$|!!$/, '').trim(); }
            }
            domMove.removeAttribute('title');
        });
        const summaryContainer = document.querySelector('.advice-summary');
        if(summaryContainer) { summaryContainer.querySelectorAll('.custom-move-stat').forEach(el => el.remove()); }

        let moves = [];
        let previousEval = { value: 0 };

        domMoves.forEach((domMove, domIndex) => {
            if (domMove.classList.contains('empty')) return;
            const sanNode = domMove.querySelector('san');
            if (sanNode) {
                const originalMoveHTML = sanNode.innerHTML.trim();
                const isCheckmatingMove = originalMoveHTML.endsWith('#');
                moves.push(originalMoveHTML);
                let currentMoveIndex = moves.length - 1;
                let currentColor = checkColor(currentMoveIndex);
                let isBookMove = !!sanNode.querySelector('i.fa-book');

                // Handle opening moves
                if (!isBookMove && currentEcoCodes.length > 0) {
                    let currentPgn = createPgnMoves(moves);
                    let foundOpening = currentEcoCodes.find(eco => eco.moves.toLowerCase().trim() == currentPgn.toLowerCase().trim());
                    if (foundOpening) {
                        handleOpeningMoveStrict(sanNode, originalMoveHTML, foundOpening, currentColor, domMove);
                        isBookMove = true;
                    }
                } else if (isBookMove && !processedNodesForBook.has(domMove)) {
                     currentMovesData[currentColor].book++;
                     processedNodesForBook.add(domMove);
                }

                // Strict v0.5 Evaluation Logic
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
                            if (currentColor === 'white') {
                                if (delta >= BRILLANT_MOVE_THRESOLD) { sanNode.innerHTML = `<span style="color: #1baca6;">${originalMoveHTML}!!</span>`; currentMovesData.white.brillant++; annotationAdded = true; }
                                if (!annotationAdded && delta >= EXCELLENT_MOVE_THRESOLD) { sanNode.innerHTML = `<span style="color: #96bc4b;">${originalMoveHTML}!</span>`; currentMovesData.white.excellent++; annotationAdded = true; }
                                if (!annotationAdded && delta >= GOOD_MOVE_THRESOLD) { sanNode.innerHTML = `<span style="color: #b2f196;">${originalMoveHTML}!?</span>`; currentMovesData.white.good++; annotationAdded = true; }
                            } else { // Black
                                if (delta <= -BRILLANT_MOVE_THRESOLD) { sanNode.innerHTML = `<span style="color: #1baca6;">${originalMoveHTML}!!</span>`; currentMovesData.black.brillant++; annotationAdded = true; }
                                if (!annotationAdded && delta <= -EXCELLENT_MOVE_THRESOLD) { sanNode.innerHTML = `<span style="color: #96bc4b;">${originalMoveHTML}!</span>`; currentMovesData.black.excellent++; annotationAdded = true; }
                                if (!annotationAdded && delta <= -GOOD_MOVE_THRESOLD) { sanNode.innerHTML = `<span style="color: #b2f196;">${originalMoveHTML}!?</span>`; currentMovesData.black.good++; annotationAdded = true; }
                            }
                        }
                    }
                } else { // Skipped eval annotation
                    if (evalNode) {
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
        console.log('Updating summary table...');
        if (!summaryContainer || !isProcessing) { console.warn(`Invalid summary or processing flag false.`); finishProcessing(false); return; }
        const summarySides = summaryContainer.querySelectorAll('.advice-summary__side');
        if (summarySides.length < 2) { console.warn(`Less than 2 summary sides.`); finishProcessing(false); return; }
        const whiteTable = Array.from(summarySides).find(side => side.querySelector('.color-icon.white'));
        const blackTable = Array.from(summarySides).find(side => side.querySelector('.color-icon.black'));
        if (!whiteTable || !blackTable) { console.warn('Could not ID white/black summary sides.'); finishProcessing(false); return; }

        function dataPoint(colour, symbol, data, text, table, coloured, className) {
            let beforeNode = null;
            const childNodes = Array.from(table.childNodes);
            const insertBeforeTerms = [ 'imprecisiones', 'Imprecisiones', 'imprecisión', 'Imprecisión', 'inaccuracies', 'Inaccuracies', 'inaccuracy', 'Inaccuracy', 'Error', 'Errores', 'Mistake', 'Errores graves', 'Blunder', 'Pérdida promedio', 'average centipawn loss', 'Precisión', 'Accuracy' ];
            for (const term of insertBeforeTerms) {
                 const potentialNode = childNodes.find(node => node.nodeType === Node.ELEMENT_NODE && (node.textContent || '').includes(term));
                 if (potentialNode?.offsetParent) { beforeNode = potentialNode; break; }
            }
            const div = document.createElement('div');
            if (data !== 0 && coloured) { div.style.color = coloured; }
            div.classList.add('custom-move-stat', className, 'symbol', 'advice-summary__error');
            div.setAttribute('data-color', colour); div.setAttribute('data-symbol', symbol);
            const strong = document.createElement('strong'); strong.textContent = data;
            div.appendChild(strong); div.appendChild(document.createTextNode(' ' + text));
            if (beforeNode) { table.insertBefore(div, beforeNode); } else { table.appendChild(div); }
        }
        dataPoint('white','!!',currentMovesData.white.brillant,' brillantes',whiteTable,'#1baca6', 'stat-brilliant-w');
        dataPoint('white','!',currentMovesData.white.excellent,' excelentes',whiteTable,'#96bc4b', 'stat-excellent-w');
        dataPoint('white','!?',currentMovesData.white.good,' buenas',whiteTable,'#b2f196', 'stat-good-w');
        dataPoint('white','Book',currentMovesData.white.book,' de libro',whiteTable,'#a88865', 'stat-book-w');
        dataPoint('black','!!',currentMovesData.black.brillant,' brillantes',blackTable,'#1baca6', 'stat-brilliant-b');
        dataPoint('black','!',currentMovesData.black.excellent,' excelentes',blackTable,'#96bc4b', 'stat-excellent-b');
        dataPoint('black','!?',currentMovesData.black.good,' buenas',blackTable,'#b2f196', 'stat-good-b');
        dataPoint('black','Book',currentMovesData.black.book,' de libro',blackTable,'#a88865', 'stat-book-b');

        console.log('Summary table updated successfully.');
        finishProcessing(true); // Finish successfully
    }


    function finishProcessing(success) {
        // console.log(`Processing finished ${success ? 'successfully' : 'unsuccessfully'}.`);
        if (isProcessing) { isProcessing = false; }
        // Observer remains active
    }

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
        console.log("Lichess Detailed Moves script running (v1.29 - Loader ID Detection)...");
        loadEcoCodesApi(() => {
             console.log("ECO codes pre-loaded. Setting up observer.");
             setupObserver();
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