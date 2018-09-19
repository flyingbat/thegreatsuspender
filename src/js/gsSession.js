/*global chrome, localStorage, tgs, gsStorage, gsIndexedDb, gsUtils, gsChrome, gsMessages, gsAnalytics */
// eslint-disable-next-line no-unused-vars
var gsSession = (function() {
  'use strict';

  const tabsToInitPerSecond = 8;

  let startupChecksComplete = false;
  let initialisationMode = false;
  let initPeriodInSeconds;
  let initTimeoutInSeconds;
  let extensionRestartContainsSuspendedTabs = false;
  let recoveryMode = false;
  let sessionId;
  let recoveryTabId;
  let updateType = null;

  function init() {
    //handle special event where an extension update is available
    chrome.runtime.onUpdateAvailable.addListener(function(details) {
      prepareForUpdate(details); //async
    });
  }

  async function prepareForUpdate(newVersionDetails) {
    var currentVersion = chrome.runtime.getManifest().version;
    var newVersion = newVersionDetails.version;

    gsUtils.log(
      'gsSession',
      'A new version is available: ' + currentVersion + ' -> ' + newVersion
    );

    let sessionRestorePoint;
    const currentSession = await buildCurrentSession();
    if (currentSession) {
      sessionRestorePoint = await gsIndexedDb.createOrUpdateSessionRestorePoint(
        currentSession,
        currentVersion
      );
    }

    if (!sessionRestorePoint || gsUtils.getSuspendedTabCount() > 0) {
      let updateUrl = chrome.extension.getURL('update.html');
      let updatedUrl = chrome.extension.getURL('updated.html');
      await Promise.all([
        gsUtils.removeTabsByUrlAsPromised(updateUrl),
        gsUtils.removeTabsByUrlAsPromised(updatedUrl),
      ]);
      //show update screen
      await gsChrome.tabsCreate(updateUrl);
    } else {
      // if there are no suspended tabs then simply install the update immediately
      chrome.runtime.reload();
    }
  }

  function getSessionId() {
    if (!sessionId) {
      //turn this into a string to make comparisons easier further down the track
      sessionId = Math.floor(Math.random() * 1000000) + '';
      gsUtils.log('gsSession', 'sessionId: ', sessionId);
    }
    return sessionId;
  }

  async function buildCurrentSession() {
    const currentWindows = await gsChrome.windowsGetAll();
    var tabsExist = currentWindows.some(
      window => window.tabs && window.tabs.length
    );
    if (tabsExist) {
      const currentSession = {
        sessionId: getSessionId(),
        windows: currentWindows,
        date: new Date().toISOString(),
      };
      return currentSession;
    }
    return null;
  }

  async function updateCurrentSession() {
    const currentSession = await buildCurrentSession();
    if (currentSession) {
      await gsIndexedDb.updateSession(currentSession);
    } else {
      gsUtils.error('gsSession', 'Failed to update current session!');
    }
  }

  function isStartupChecksComplete() {
    return startupChecksComplete;
  }

  function isRecoveryMode() {
    return recoveryMode;
  }

  function isInitialising() {
    return initialisationMode;
  }

  function getUpdateType() {
    return updateType;
  }

  async function runStartupChecks() {
    initialisationMode = true;
    const tabs = await gsChrome.tabsQuery();
    await checkForBrowserStartup(tabs);
    queueCheckTabsForResponsiveness(tabs);

    var lastVersion = gsStorage.fetchLastVersion();
    var curVersion = chrome.runtime.getManifest().version;

    if (chrome.extension.inIncognitoContext) {
      // do nothing if in incognito context
    } else if (lastVersion === curVersion) {
      gsUtils.log('gsSession', 'HANDLING NORMAL STARTUP');
      await handleNormalStartup(curVersion, tabs);
    } else if (!lastVersion || lastVersion === '0.0.0') {
      gsUtils.log('gsSession', 'HANDLING NEW INSTALL');
      await handleNewInstall(curVersion);
    } else {
      gsUtils.log('gsSession', 'HANDLING UPDATE');
      await handleUpdate(curVersion, lastVersion, tabs);
    }
    startupChecksComplete = true;
  }

  async function handleNormalStartup(curVersion, tabs) {
    const shouldRecoverTabs = await checkForCrashRecovery(tabs);
    if (shouldRecoverTabs) {
      var lastExtensionRecoveryTimestamp = gsStorage.fetchLastExtensionRecoveryTimestamp();
      var hasCrashedRecently =
        lastExtensionRecoveryTimestamp &&
        Date.now() - lastExtensionRecoveryTimestamp < 1000 * 60 * 5;
      gsStorage.setLastExtensionRecoveryTimestamp(Date.now());

      if (!hasCrashedRecently) {
        //if this is the first recent crash, then automatically recover lost tabs
        await recoverLostTabs();
      } else {
        //otherwise show the recovery page
        const recoveryUrl = chrome.extension.getURL('recovery.html');
        const recoveryTab = await gsChrome.tabsCreate(recoveryUrl);
        recoveryTabId = recoveryTab.id;
        //hax0r: wait for recovery tab to finish loading before returning
        //this is so we remain in 'recoveryMode' for a bit longer, preventing
        //the sessionUpdate code from running when this tab gains focus
        await gsUtils.setTimeout(2000);
      }
    } else {
      await gsIndexedDb.trimDbItems();
    }
    gsAnalytics.reportEvent('System', 'Restart', curVersion + '');
  }

  async function handleNewInstall(curVersion) {
    gsStorage.setLastVersion(curVersion);

    //show welcome message
    const optionsUrl = chrome.extension.getURL('options.html?firstTime');
    await gsChrome.tabsCreate(optionsUrl);
    gsAnalytics.reportEvent('System', 'Install', curVersion + '');
  }

  async function handleUpdate(curVersion, lastVersion, tabs) {
    gsStorage.setLastVersion(curVersion);
    var lastVersionParts = lastVersion.split('.');
    var curVersionParts = curVersion.split('.');
    if (lastVersionParts.length >= 2 && curVersionParts.length >= 2) {
      if (parseInt(curVersionParts[0]) > parseInt(lastVersionParts[0])) {
        updateType = 'major';
      } else if (parseInt(curVersionParts[1]) > parseInt(lastVersionParts[1])) {
        updateType = 'minor';
      } else {
        updateType = 'patch';
      }
    }

    const sessionRestorePoint = await gsIndexedDb.fetchSessionRestorePoint(
      lastVersion
    );
    if (!sessionRestorePoint) {
      const lastSession = await gsIndexedDb.fetchLastSession();
      if (lastSession) {
        await gsIndexedDb.createOrUpdateSessionRestorePoint(
          lastSession,
          lastVersion
        );
      } else {
        gsUtils.error(
          'gsSession',
          'No session restore point found, and no lastSession exists!'
        );
      }
    }

    let updateUrl = chrome.extension.getURL('update.html');
    let updatedUrl = chrome.extension.getURL('updated.html');
    await gsUtils.removeTabsByUrlAsPromised(updateUrl);
    await gsUtils.removeTabsByUrlAsPromised(updatedUrl);
    const updatedTab = await gsUtils.createTabAndWaitForFinishLoading(
      updatedUrl,
      1000
    );

    await gsIndexedDb.performMigration(lastVersion);
    gsStorage.setNoticeVersion('0');
    const shouldRecoverTabs = await checkForCrashRecovery(tabs);
    if (shouldRecoverTabs) {
      await recoverLostTabs();
    }

    //update updated screen
    gsMessages.sendUpdateCompleteToUpdatedTab(updatedTab.id, async error => {
      if (error) {
        await gsUtils.removeTabsByUrlAsPromised(updatedUrl);
      }
    });

    gsAnalytics.reportEvent(
      'System',
      'Update',
      lastVersion + ' -> ' + curVersion
    );
  }

  function queueCheckTabsForResponsiveness(tabs) {
    //make sure the contentscript / suspended script of each tab is responsive
    //if we are in the process of a chrome restart (and session restore) then it might take a while
    //for the scripts to respond. we use progressive timeouts of 4, 8, 16, 32 ...
    var tabCheckPromises = [];
    gsUtils.log(
      'gsSession',
      '\n\n------------------------------------------------\n' +
        `Extension initialization started. extensionRestartContainsSuspendedTabs: ${extensionRestartContainsSuspendedTabs}\n` +
        '------------------------------------------------\n\n'
    );
    initPeriodInSeconds = tabs.length / tabsToInitPerSecond;
    initTimeoutInSeconds = initPeriodInSeconds * 15;
    gsUtils.log('gsSession', `initPeriodInSeconds: ${initPeriodInSeconds}`);
    gsUtils.log('gsSession', `initTimeoutInSeconds: ${initTimeoutInSeconds}`);

    for (const currentTab of tabs) {
      const timeout = getRandomTimeoutInMilliseconds(1000);
      gsUtils.log(
        currentTab.id,
        `Queuing tab for initialisation check in ${timeout / 1000} seconds.`
      );
      tabCheckPromises.push(queueTabScriptCheck(currentTab, timeout));
    }
    Promise.all(tabCheckPromises)
      .then(() => {
        initialisationMode = false;
        gsUtils.log(
          'gsSession',
          '\n\n------------------------------------------------\n' +
            'Extension initialization finished.\n' +
            '------------------------------------------------\n\n'
        );
      })
      .catch(error => {
        initialisationMode = false;
        gsUtils.warning('gsSession', error);
        gsUtils.warning(
          'gsSession',
          '\n\n------------------------------------------------\n' +
            'Extension initialization FAILED.\n' +
            '------------------------------------------------\n\n'
        );
      });
  }

  function getRandomTimeoutInMilliseconds(minimumTimeout) {
    minimumTimeout = minimumTimeout || 1000;
    const timeoutRandomiser = parseInt(
      Math.random() * initPeriodInSeconds * 1000
    );
    return timeoutRandomiser + minimumTimeout;
  }

  //TODO: Improve this function to determine browser startup with 100% certainty
  //NOTE: Current implementation leans towards conservatively saying it's not a browser startup
  async function checkForBrowserStartup(currentTabs) {
    //check for suspended tabs in current session
    //if found, then we can probably assume that this is a browser startup which is restoring previously open tabs
    const suspendedTabs = [];
    for (var curTab of currentTabs) {
      if (
        !gsUtils.isSpecialTab(curTab) &&
        gsUtils.isSuspendedTab(curTab, true)
      ) {
        suspendedTabs.push(curTab);
      }
    }
    if (suspendedTabs.length > 0) {
      gsUtils.log(
        'gsSession',
        'extensionRestartContainsSuspendedTabs: true',
        suspendedTabs
      );
      extensionRestartContainsSuspendedTabs = true;
    }
  }

  async function checkForCrashRecovery(currentTabs) {
    gsUtils.log(
      'gsSession',
      'Checking for crash recovery: ' + new Date().toISOString()
    );

    if (extensionRestartContainsSuspendedTabs) {
      gsUtils.log(
        'gsSession',
        'Aborting tab recovery. Browser is probably starting (as there are still suspended tabs open..)'
      );
      return false;
    }

    //try to detect whether the extension has crashed as separate to chrome crashing
    //if it is just the extension that has crashed, then in theory all suspended tabs will be gone
    //and all normal tabs will still exist with the same ids
    var lastSessionSuspendedTabCount = 0,
      lastSessionUnsuspendedTabCount = 0,
      lastSessionUnsuspendedTabs = [];

    const lastSession = await gsIndexedDb.fetchLastSession();
    if (!lastSession) {
      return false;
    }
    gsUtils.log('gsSession', 'lastSession: ', lastSession);

    //collect all nonspecial, unsuspended tabs from the last session
    for (const sessionWindow of lastSession.windows) {
      for (const sessionTab of sessionWindow.tabs) {
        if (!gsUtils.isSpecialTab(sessionTab)) {
          if (!gsUtils.isSuspendedTab(sessionTab, true)) {
            lastSessionUnsuspendedTabs.push(sessionTab);
            lastSessionUnsuspendedTabCount++;
          } else {
            lastSessionSuspendedTabCount++;
          }
        }
      }
    }

    //don't attempt recovery if last session had no suspended tabs
    if (lastSessionSuspendedTabCount === 0) {
      gsUtils.log(
        'gsSession',
        'Aborting tab recovery. Last session has no suspended tabs.'
      );
      return false;
    }

    //check to see if they still exist in current session
    gsUtils.log('gsSession', 'currentTabs: ', currentTabs);
    gsUtils.log(
      'gsSession',
      'lastSessionUnsuspendedTabs: ',
      lastSessionUnsuspendedTabs
    );

    //don't attempt recovery if there are less tabs in current session than there were
    //unsuspended tabs in the last session
    if (currentTabs.length < lastSessionUnsuspendedTabCount) {
      gsUtils.log(
        'gsSession',
        'Aborting tab recovery. Last session contained ' +
          lastSessionUnsuspendedTabCount +
          'unsuspended tabs. Current session only contains ' +
          currentTabs.length +
          '. Assuming this is New Tab with a restore? prompt.'
      );
      return false;
    }

    //if there is only one currently open tab and it is the 'new tab' page then abort recovery
    if (currentTabs.length === 1 && currentTabs[0].url === 'chrome://newtab/') {
      gsUtils.log(
        'gsSession',
        'Aborting tab recovery. Current session only contains a single newtab page.'
      );
      return false;
    }
    return true;
  }

  async function queueTabScriptCheck(tab, timeout, totalTimeQueued) {
    totalTimeQueued = totalTimeQueued || 0;
    if (gsUtils.isSpecialTab(tab) || gsUtils.isDiscardedTab(tab)) {
      return;
    }
    if (totalTimeQueued >= initTimeoutInSeconds * 1000) {
      gsUtils.warning(
        tab.id,
        `Failed to initialize tab. Tab may not behave as expected.`
      );
      return;
    }
    await gsUtils.setTimeout(timeout);
    let _tab = await fetchUpdatedTab(tab);
    if (!_tab) {
      gsUtils.warning(
        tab.id,
        `Failed to initialize tab. Tab may have been removed or discarded.`
      );
      return;
    } else {
      tab = _tab;
    }
    totalTimeQueued += timeout;
    gsUtils.log(
      tab.id,
      `${parseInt(
        totalTimeQueued / 1000
      )} seconds has elapsed. Pinging tab with state: ${tab.status}..`
    );
    const result = await pingTabScript(tab, totalTimeQueued);
    if (!result) {
      const nextTimeout = getRandomTimeoutInMilliseconds(5000);
      gsUtils.warning(
        tab.id,
        `Tab has still not initialised after ${totalTimeQueued /
          1000}. Re-queuing in another ${nextTimeout / 1000} seconds.`
      );
      await queueTabScriptCheck(tab, nextTimeout, totalTimeQueued);
    }
  }

  async function fetchUpdatedTab(tab) {
    const newTab = await gsChrome.tabsGet(tab.id);
    if (newTab) {
      return newTab;
    }
    if (!gsUtils.isSuspendedTab(tab, true)) {
      return null;
    }
    // If suspended tab has been discarded before init then it may stay in 'blockhead' state
    // Therefore we want to reload this tab to make sure it can be suspended properly
    const discardedTab = await findPotentialDiscardedSuspendedTab(tab);
    if (!discardedTab) {
      return null;
    }
    gsUtils.warning(
      discardedTab.id,
      `Suspended tab with id: ${
        tab.id
      } was discarded before init. Will reload..`
    );
    await gsChrome.tabsUpdate(discardedTab.id, { url: discardedTab.url });
    return discardedTab;
  }

  async function findPotentialDiscardedSuspendedTab(suspendedTab) {
    // NOTE: For some reason querying by url doesn't work here??
    let tabs = new Promise(r =>
      chrome.tabs.query(
        {
          discarded: true,
          windowId: suspendedTab.windowId,
        },
        r
      )
    );
    tabs = tabs.filter(o => o.url === suspendedTab.url);
    if (tabs.length === 1) {
      return tabs[0];
    } else if (tabs.length > 1) {
      let matchingTab = tabs.find(o => o.index === suspendedTab.index);
      matchingTab = matchingTab || tabs[0];
      return matchingTab;
    } else {
      return null;
    }
  }

  async function pingTabScript(tab, totalTimeQueued) {
    // If tab has a state of loading, then requeue for checking later
    if (tab.status === 'loading') {
      gsUtils.log(tab.id, 'Tab is still loading');
      return false;
    }

    let tabResponse = await new Promise(resolve => {
      gsMessages.sendPingToTab(tab.id, function(error, _response) {
        if (error) {
          gsUtils.warning(tab.id, 'Failed to sendPingToTab', error);
        }
        resolve(_response);
      });
    });

    if (!tabResponse) {
      // If it is a suspended tab then try reloading the tab and requeue for checking later
      if (gsUtils.isSuspendedTab(tab)) {
        requestReloadSuspendedTab(tab);
        return false;
      }

      // If it is a normal tab then try to reinject content script
      const result = await reinjectContentScriptOnTab(tab);
      if (!result) {
        gsUtils.warning(
          tab.id,
          'Failed to initialize tab. Tab may not behave as expected.'
        );
        // Give up on this tab
        return true;
      }

      // If we have successfull injected content script, then try to ping again
      tabResponse = await new Promise(resolve => {
        gsMessages.sendPingToTab(tab.id, function(error, _response) {
          resolve(_response);
        });
      });
    }

    // If tab still doesn't respond to ping, then requeue for checking later
    if (!tabResponse) {
      return false;
    }

    // If tab returned a response but is not initialised, then try to initialise
    if (!tabResponse.isInitialised) {
      try {
        if (gsUtils.isSuspendedTab(tab)) {
          tabResponse = await tgs.initialiseSuspendedTabAsPromised(tab);
        } else {
          tabResponse = await tgs.initialiseUnsuspendedTabAsPromised(tab);
        }
      } catch (error) {
        gsUtils.warning(tab.id, 'Failed to initialiseTabAsPromised', error);
      }
    }

    // If tab is initialised then return true
    if (tabResponse && tabResponse.isInitialised) {
      gsUtils.log(tab.id, 'Tab has initialised successfully.');
      return true;
    } else {
      return false;
    }
  }

  function requestReloadSuspendedTab(tab) {
    // resuspend unresponsive suspended tabs
    gsUtils.log(tab.id, 'Resuspending unresponsive suspended tab.');
    tgs.setTabFlagForTabId(tab.id, tgs.UNSUSPEND_ON_RELOAD_URL, null);
    chrome.tabs.reload(tab.id, function() {
      // Ignore callback here as we need to wait for the suspended tab
      // to finish reloading before we can check again
    });
  }

  async function reinjectContentScriptOnTab(tab) {
    return new Promise(resolve => {
      gsUtils.log(
        tab.id,
        'Reinjecting contentscript into unresponsive active tab.'
      );
      gsMessages.executeScriptOnTab(tab.id, 'js/contentscript.js', error => {
        if (error) {
          gsUtils.warning(
            tab.id,
            'Failed to execute js/contentscript.js on tab',
            error
          );
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  async function recoverLostTabs() {
    const lastSession = await gsIndexedDb.fetchLastSession();
    if (!lastSession) {
      return;
    }

    gsUtils.log(
      'gsSession',
      '\n\n------------------------------------------------\n' +
        'Recovery mode started.\n' +
        '------------------------------------------------\n\n'
    );

    recoveryMode = true;
    gsUtils.removeInternalUrlsFromSession(lastSession);

    const currentWindows = await gsChrome.windowsGetAll();
    var matchedCurrentWindowBySessionWindowId = matchCurrentWindowsWithLastSessionWindows(
      lastSession.windows,
      currentWindows
    );

    //attempt to automatically restore any lost tabs/windows in their proper positions
    const lastFocusedWindow = await gsChrome.windowsGetLastFocused();
    const lastFocusedWindowId = lastFocusedWindow ? lastFocusedWindow.id : null;
    for (var sessionWindow of lastSession.windows) {
      var matchedCurrentWindow =
        matchedCurrentWindowBySessionWindowId[sessionWindow.id];
      await restoreSessionWindow(sessionWindow, matchedCurrentWindow, 0);
    }
    if (lastFocusedWindowId) {
      await gsChrome.windowsUpdate(lastFocusedWindowId, { focused: true });
    }

    recoveryMode = false;
    gsUtils.log(
      'gsSession',
      '\n\n------------------------------------------------\n' +
        'Recovery mode finished.\n' +
        '------------------------------------------------\n\n'
    );
    gsUtils.log('gsSession', 'updating current session');
    updateCurrentSession(); //async
  }

  //try to match session windows with currently open windows
  function matchCurrentWindowsWithLastSessionWindows(
    unmatchedSessionWindows,
    unmatchedCurrentWindows
  ) {
    var matchedCurrentWindowBySessionWindowId = {};

    //if there is a current window open that matches the id of the session window id then match it
    unmatchedSessionWindows.slice().forEach(function(sessionWindow) {
      var matchingCurrentWindow = unmatchedCurrentWindows.find(function(
        window
      ) {
        return window.id === sessionWindow.id;
      });
      if (matchingCurrentWindow) {
        matchedCurrentWindowBySessionWindowId[
          sessionWindow.id
        ] = matchingCurrentWindow;
        //remove from unmatchedSessionWindows and unmatchedCurrentWindows
        unmatchedSessionWindows = unmatchedSessionWindows.filter(function(
          window
        ) {
          return window.id !== sessionWindow.id;
        });
        unmatchedCurrentWindows = unmatchedCurrentWindows.filter(function(
          window
        ) {
          return window.id !== matchingCurrentWindow.id;
        });
        gsUtils.log(
          'gsUtils',
          'Matched with ids: ',
          sessionWindow,
          matchingCurrentWindow
        );
      }
    });

    if (
      unmatchedSessionWindows.length === 0 ||
      unmatchedCurrentWindows.length === 0
    ) {
      return matchedCurrentWindowBySessionWindowId;
    }

    //if we still have session windows that haven't been matched to a current window then attempt matching based on tab urls
    var tabMatchingObjects = generateTabMatchingObjects(
      unmatchedSessionWindows,
      unmatchedCurrentWindows
    );

    //find the tab matching objects with the highest tabMatchCounts
    while (
      unmatchedSessionWindows.length > 0 &&
      unmatchedCurrentWindows.length > 0
    ) {
      var maxTabMatchCount = Math.max(
        ...tabMatchingObjects.map(function(o) {
          return o.tabMatchCount;
        })
      );
      var bestTabMatchingObject = tabMatchingObjects.find(function(o) {
        return o.tabMatchCount === maxTabMatchCount;
      });

      matchedCurrentWindowBySessionWindowId[
        bestTabMatchingObject.sessionWindow.id
      ] =
        bestTabMatchingObject.currentWindow;

      //remove from unmatchedSessionWindows and unmatchedCurrentWindows
      var unmatchedSessionWindowsLengthBefore = unmatchedSessionWindows.length;
      unmatchedSessionWindows = unmatchedSessionWindows.filter(function(
        window
      ) {
        return window.id !== bestTabMatchingObject.sessionWindow.id;
      });
      unmatchedCurrentWindows = unmatchedCurrentWindows.filter(function(
        window
      ) {
        return window.id !== bestTabMatchingObject.currentWindow.id;
      });
      gsUtils.log(
        'gsUtils',
        'Matched with tab count of ' + maxTabMatchCount + ': ',
        bestTabMatchingObject.sessionWindow,
        bestTabMatchingObject.currentWindow
      );

      //remove from tabMatchingObjects
      tabMatchingObjects = tabMatchingObjects.filter(function(o) {
        return (
          (o.sessionWindow !== bestTabMatchingObject.sessionWindow) &
          (o.currentWindow !== bestTabMatchingObject.currentWindow)
        );
      });

      //safety check to make sure we dont get stuck in infinite loop. should never happen though.
      if (
        unmatchedSessionWindows.length >= unmatchedSessionWindowsLengthBefore
      ) {
        break;
      }
    }

    return matchedCurrentWindowBySessionWindowId;
  }

  function generateTabMatchingObjects(sessionWindows, currentWindows) {
    var unsuspendedSessionUrlsByWindowId = {};
    sessionWindows.forEach(function(sessionWindow) {
      unsuspendedSessionUrlsByWindowId[sessionWindow.id] = [];
      sessionWindow.tabs.forEach(function(curTab) {
        if (!gsUtils.isSpecialTab(curTab) && !gsUtils.isSuspendedTab(curTab)) {
          unsuspendedSessionUrlsByWindowId[sessionWindow.id].push(curTab.url);
        }
      });
    });
    var unsuspendedCurrentUrlsByWindowId = {};
    currentWindows.forEach(function(currentWindow) {
      unsuspendedCurrentUrlsByWindowId[currentWindow.id] = [];
      currentWindow.tabs.forEach(function(curTab) {
        if (!gsUtils.isSpecialTab(curTab) && !gsUtils.isSuspendedTab(curTab)) {
          unsuspendedCurrentUrlsByWindowId[currentWindow.id].push(curTab.url);
        }
      });
    });

    var tabMatchingObjects = [];
    sessionWindows.forEach(function(sessionWindow) {
      currentWindows.forEach(function(currentWindow) {
        var unsuspendedSessionUrls =
          unsuspendedSessionUrlsByWindowId[sessionWindow.id];
        var unsuspendedCurrentUrls =
          unsuspendedCurrentUrlsByWindowId[currentWindow.id];
        var matchCount = unsuspendedCurrentUrls.filter(function(url) {
          return unsuspendedSessionUrls.includes(url);
        }).length;
        tabMatchingObjects.push({
          tabMatchCount: matchCount,
          sessionWindow: sessionWindow,
          currentWindow: currentWindow,
        });
      });
    });

    return tabMatchingObjects;
  }

  // suspendMode controls whether the tabs are restored as suspended or unsuspended
  // 0: Leave the urls as they are (suspended stay suspended, ussuspended stay unsuspended)
  // 1: Open all unsuspended tabs as suspended
  // 2: Open all suspended tabs as unsuspended
  async function restoreSessionWindow(
    sessionWindow,
    existingWindow,
    suspendMode
  ) {
    if (sessionWindow.tabs.length === 0) {
      gsUtils.log('gsUtils', 'SessionWindow contains no tabs to restore');
      return;
    }

    // if we have been provided with a current window to recover into
    if (existingWindow) {
      const currentTabIds = [];
      const currentTabUrls = [];
      const tabPromises = [];
      for (const currentTab of existingWindow.tabs) {
        currentTabIds.push(currentTab.id);
        currentTabUrls.push(currentTab.url);
      }

      for (const sessionTab of sessionWindow.tabs) {
        //if current tab does not exist then recreate it
        if (
          !gsUtils.isSpecialTab(sessionTab) &&
          !currentTabUrls.includes(sessionTab.url) &&
          !currentTabIds.includes(sessionTab.id)
        ) {
          tabPromises.push(
            createNewTabFromSessionTab(
              sessionTab,
              existingWindow.id,
              suspendMode
            )
          );
        }
      }
      await Promise.all(tabPromises);
      return;
    }

    // else restore entire window
    gsUtils.log(
      'gsUtils',
      'Could not find match for sessionWindow: ',
      sessionWindow
    );

    const restoringUrl = chrome.extension.getURL('restoring-window.html');
    const newWindow = await gsUtils.createWindowAndWaitForFinishLoading(
      { url: restoringUrl, focused: false },
      500 // dont actually wait
    );
    const placeholderTab = newWindow.tabs[0];
    const tabPromises = [];
    for (const sessionTab of sessionWindow.tabs) {
      tabPromises.push(
        createNewTabFromSessionTab(sessionTab, newWindow.id, suspendMode)
      );
    }
    await Promise.all(tabPromises);
    if (placeholderTab) {
      await gsChrome.tabsRemove(placeholderTab.id);
    }
    return;
  }

  async function createNewTabFromSessionTab(sessionTab, windowId, suspendMode) {
    let url = sessionTab.url;
    if (
      suspendMode === 1 &&
      !gsUtils.isSuspendedTab(sessionTab) &&
      !gsUtils.isSpecialTab(sessionTab)
    ) {
      url = gsUtils.generateSuspendedUrl(sessionTab.url, sessionTab.title);
    } else if (suspendMode === 2 && gsUtils.isSuspendedTab(sessionTab)) {
      url = gsUtils.getSuspendedUrl(sessionTab.url);
    }
    const newTab = await gsChrome.tabsCreate({
      windowId: windowId,
      url: url,
      index: sessionTab.index,
      pinned: sessionTab.pinned,
      active: false,
    });

    // Update recovery view (if it exists)
    if (recoveryTabId) {
      gsMessages.sendTabInfoToRecoveryTab(recoveryTabId, newTab); //async. unhandled error
    }
  }

  return {
    init,
    runStartupChecks,
    getSessionId,
    buildCurrentSession,
    updateCurrentSession,
    isInitialising,
    isStartupChecksComplete,
    isRecoveryMode,
    recoverLostTabs,
    restoreSessionWindow,
    prepareForUpdate,
    getUpdateType,
  };
})();
