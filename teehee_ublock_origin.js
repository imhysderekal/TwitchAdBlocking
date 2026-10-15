twitch-videoad.js text/javascript
(function() {
    if ( /(^|\.)twitch\.tv$/.test(document.location.hostname) === false ) { return; }
    'use strict';
    const ourTwitchAdSolutionsVersion = 25;// Incremented version to supersede v24 scripts
    if (typeof window.twitchAdSolutionsVersion !== 'undefined' && window.twitchAdSolutionsVersion >= ourTwitchAdSolutionsVersion) {
        console.log("skipping vaft as there's another script active. ourVersion:" + ourTwitchAdSolutionsVersion + " activeVersion:" + window.twitchAdSolutionsVersion);
        window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
        return;
    }
    window.twitchAdSolutionsVersion = ourTwitchAdSolutionsVersion;
    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'embed',//Source
            'popout',//Source
            'site',//Source
            'frontpage',//Source / 720p
            'mobile_web',//720p / 480p
            'picture-by-picture',//360p
            'autoplay'//360p (Android platform fallback, rarely served prerolls)
        ];
        scope.FallbackPlayerType = 'embed';
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.SkipPlayerReloadOnHevc = false;// If true this will skip player reload on streams which have 2k/4k quality (if you enable this and you use the 2k/4k quality setting you'll get error #4000 / #3000 / spinning wheel on chrome based browsers)
        scope.AlwaysReloadPlayerOnAd = false;// Always pause/play when entering/leaving ads
        scope.ReloadPlayerAfterAd = true;// After the ad finishes do a player reload instead of pause/play
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadMinimalRequestsPlayerIndex = 6;//autoplay index in BackupPlayerTypes
        scope.HasTriggeredPlayerReload = false;
        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.PlayerBufferingFix = true;// If true this will pause/play the player when it gets stuck buffering
        scope.PlayerBufferingDelay = 600;// How often should we check the player state (in milliseconds)
        scope.PlayerBufferingFoundDelay = 250;// Faster re-check interval (in milliseconds) once potential buffering state is detected
        scope.PlayerBufferingSameStateCount = 3;// How many times of seeing the same player state until we trigger pause/play (it will only trigger it one time until the player state changes again)
        scope.PlayerBufferingDangerZone = 1;// The buffering time left (in seconds) when we should ignore the players playback position in the player state check
        scope.PlayerBufferingDoPlayerReload = false;// If true this will do a player reload instead of pause/play (player reloading is better at fixing the playback issues but it takes slightly longer)
        scope.PlayerBufferingMinRepeatDelay = 8000;// Minimum delay (in milliseconds) between each pause/play (this is to avoid over pressing pause/play when there are genuine buffering problems)
        scope.PlayerBufferingPrerollCheckEnabled = false;// Enable this if you're getting an immediate pause/play/reload as you open a stream (which is causing the stream to take longer to load). One problem with this being true is that it can cause the player to get stuck in some instances requiring the user to press pause/play
        scope.PlayerBufferingPrerollCheckOffset = 5;// How far the stream need to move before doing the buffering mitigation (depends on PlayerBufferingPrerollCheckEnabled being true)
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.LiveSegmentCache = new Map();// Maps timestamp (ms) -> segment URL from clean backup playlists for PDT segment stitching
        scope.BackupPlayerCooldowns = new Map();// Maps channelName:playerType -> timestamp until which a backup type with ads is skipped
        scope.BackupPlayerCooldownMs = 4500;// Cooldown (ms) before re-querying a backup player type that returned ads
        scope.ParallelBackupRequests = true;// Fetch remaining backup player types concurrently when primary backup has ads
        scope.BlockClientSideAds = true;// Intercept edge.ads.twitch.tv / client-side ad insertion (CSAI) and GQL ad telemetry
        scope.AllSegmentsAreAdSegments = false;
    }
    let isActivelyStrippingAds = false;
    let localStorageHookFailed = false;
    const twitchWorkers = [];
    const workerStringConflicts = [
        'twitch',
        'isVariantA'// TwitchNoSub
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'isVariantA',// TwitchNoSub (prior to (0.9))
        'besuper/',// TwitchNoSub (0.9)
        '${patch_url}'// TwitchNoSub (0.9.1)
    ];
    function getCleanWorker(worker) {
        let root = null;
        let parent = null;
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringConflicts.some((x) => workerString.includes(x)) && !workerStringAllow.some((x) => workerString.includes(x))) {
                if (parent !== null) {
                    Object.setPrototypeOf(parent, Object.getPrototypeOf(proto));
                }
            } else {
                if (root === null) {
                    root = proto;
                }
                parent = proto;
            }
            proto = Object.getPrototypeOf(proto);
        }
        return root;
    }
    function getWorkersForReinsert(worker) {
        const result = [];
        let proto = worker;
        while (proto) {
            const workerString = proto.toString();
            if (workerStringReinsert.some((x) => workerString.includes(x))) {
                result.push(proto);
            }
            proto = Object.getPrototypeOf(proto);
        }
        return result;
    }
    function reinsertWorkers(worker, reinsert) {
        let parent = worker;
        for (let i = 0; i < reinsert.length; i++) {
            Object.setPrototypeOf(reinsert[i], parent);
            parent = reinsert[i];
        }
        return parent;
    }
    function isValidWorker(worker) {
        const workerString = worker.toString();
        return !workerStringConflicts.some((x) => workerString.includes(x))
            || workerStringAllow.some((x) => workerString.includes(x))
            || workerStringReinsert.some((x) => workerString.includes(x));
    }
    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(window.Worker);
        const newWorker = class Worker extends getCleanWorker(window.Worker) {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    const workerOrigin = new URL(twitchBlobUrl).origin;
                    isTwitchWorker = workerOrigin.endsWith('.twitch.tv') || workerOrigin.endsWith('.twitchcdn.net');
                } catch {}
                if (!isTwitchWorker) {
                    super(twitchBlobUrl, options);
                    return;
                }
                const newBlobStr = `
                    const pendingFetchRequests = new Map();
                    ${getCodecFamily.toString()}
                    ${hasPlaylistAds.toString()}
                    ${parseAdDateRanges.toString()}
                    ${cacheLiveSegmentsFromM3u8.toString()}
                    ${getLatestPdtFromM3u8.toString()}
                    ${stripAdSegments.toString()}
                    ${getStreamUrlForResolution.toString()}
                    ${fetchBackupPlaylistForType.toString()}
                    ${prewarmBackupEncodings.toString()}
                    ${processM3U8.toString()}
                    ${hookWorkerFetch.toString()}
                    ${declareOptions.toString()}
                    ${getPlatformForPlayerType.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${parseAttributes.toString()}
                    ${getWasmWorkerJs.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    const workerString = getWasmWorkerJs('${twitchBlobUrl.replaceAll("'", "%27")}');
                    declareOptions(self);
                    GQLDeviceID = ${GQLDeviceID ? "'" + GQLDeviceID + "'" : null};
                    AuthorizationHeader = ${AuthorizationHeader ? "'" + AuthorizationHeader + "'" : undefined};
                    ClientIntegrityHeader = ${ClientIntegrityHeader ? "'" + ClientIntegrityHeader + "'" : null};
                    ClientVersion = ${ClientVersion ? "'" + ClientVersion + "'" : null};
                    ClientSession = ${ClientSession ? "'" + ClientSession + "'" : null};
                    self.addEventListener('message', function(e) {
                        if (e.data.key == 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key == 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key == 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key == 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key == 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key == 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key == 'FetchResponse') {
                            const responseData = e.data.value;
                            if (pendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject } = pendingFetchRequests.get(responseData.id);
                                pendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    // Create a Response object from the response data
                                    const response = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    resolve(response);
                                }
                            }
                        } else if (e.data.key == 'TriggeredPlayerReload') {
                            HasTriggeredPlayerReload = true;
                        } else if (e.data.key == 'PrewarmBackups') {
                            prewarmBackupEncodings(e.data.value);
                        } else if (e.data.key == 'SimulateAds') {
                            SimulatedAdsDepth = e.data.value;
                            console.log('SimulatedAdsDepth: ' + SimulatedAdsDepth);
                        } else if (e.data.key == 'AllSegmentsAreAdSegments') {
                            AllSegmentsAreAdSegments = !AllSegmentsAreAdSegments;
                            console.log('AllSegmentsAreAdSegments: ' + AllSegmentsAreAdSegments);
                        }
                    });
                    hookWorkerFetch();
                    eval(workerString);
                `;
                super(URL.createObjectURL(new Blob([newBlobStr])), options);
                twitchWorkers.push(this);
                this.addEventListener('message', (e) => {
                    if (e.data.key == 'UpdateAdBlockBanner') {
                        updateAdblockBanner(e.data);
                    } else if (e.data.key == 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key == 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
                    }
                });
                this.addEventListener('message', async event => {
                    if (event.data.key == 'FetchRequest') {
                        const fetchRequest = event.data.value;
                        const responseData = await handleWorkerFetchRequest(fetchRequest);
                        this.postMessage({
                            key: 'FetchResponse',
                            value: responseData
                        });
                    }
                });
            }
        };
        let workerInstance = reinsertWorkers(newWorker, reinsert);
        Object.defineProperty(window, 'Worker', {
            get: function() {
                return workerInstance;
            },
            set: function(value) {
                if (isValidWorker(value)) {
                    workerInstance = value;
                } else {
                    console.log('Attempt to set twitch worker denied');
                }
            }
        });
    }
    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.overrideMimeType("text/javascript");
        req.send();
        return req.responseText;
    }
    function getCodecFamily(codecsStr) {
        if (!codecsStr || typeof codecsStr !== 'string') {
            return 'avc';
        }
        const lower = codecsStr.toLowerCase();
        if (lower.includes('hev') || lower.includes('hvc')) {
            return 'hevc';
        }
        if (lower.includes('av01') || lower.includes('av0')) {
            return 'av1';
        }
        return 'avc';
    }
    function hasPlaylistAds(textStr) {
        if (!textStr) {
            return false;
        }
        return textStr.includes(AdSignifier)
            || textStr.includes('twitch-stitched-ad')
            || textStr.includes('X-TV-TWITCH-AD-')
            || /#EXTINF:[0-9.]+,(?:Amazon|FT\|)/.test(textStr);
    }
    function parseAdDateRanges(lines) {
        const ranges = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXT-X-DATERANGE:') && (line.includes(AdSignifier) || line.includes('twitch-stitched-ad') || line.includes('X-TV-TWITCH-AD-'))) {
                const attrs = parseAttributes(line.substring('#EXT-X-DATERANGE:'.length));
                const startDateStr = attrs['START-DATE'];
                if (startDateStr) {
                    const startMs = Date.parse(startDateStr);
                    if (!Number.isNaN(startMs)) {
                        let durationSec = Number(attrs['X-TV-TWITCH-AD-POD-FILLED-DURATION'] || attrs['DURATION'] || attrs['PLANNED-DURATION'] || 30);
                        if (Number.isNaN(durationSec) || durationSec <= 0) {
                            durationSec = 30;
                        }
                        let endMs = startMs + (durationSec * 1000);
                        if (attrs['END-DATE']) {
                            const parsedEnd = Date.parse(attrs['END-DATE']);
                            if (!Number.isNaN(parsedEnd)) {
                                endMs = parsedEnd;
                            }
                        }
                        ranges.push({ startMs, endMs });
                    }
                }
            }
        }
        return ranges;
    }
    function cacheLiveSegmentsFromM3u8(textStr, codecFamily) {
        if (!textStr) {
            return;
        }
        const lines = textStr.replaceAll('\r', '').split('\n');
        const adRanges = parseAdDateRanges(lines);
        let currentPdtMs = null;
        for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i];
            if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                const pdtStr = line.substring('#EXT-X-PROGRAM-DATE-TIME:'.length).trim();
                const ms = Date.parse(pdtStr);
                currentPdtMs = Number.isNaN(ms) ? null : Math.round(ms / 500) * 500;
            } else if (line.startsWith('#EXTINF:') && currentPdtMs !== null) {
                const nextLine = lines[i + 1];
                const inAdRange = adRanges.some(r => currentPdtMs >= r.startMs - 500 && currentPdtMs <= r.endMs + 500);
                const isLiveExtinf = line.includes(',live') && !line.includes('Amazon') && !line.includes('FT|') && !inAdRange;
                if (isLiveExtinf && nextLine && nextLine.startsWith('http')) {
                    LiveSegmentCache.set(`${codecFamily}:${currentPdtMs}`, {
                        url: nextLine.trim(),
                        extinf: line,
                        cachedAt: Date.now()
                    });
                }
                currentPdtMs = null;
            }
        }
        const cutoff = Date.now() - 60000;
        LiveSegmentCache.forEach((val, key, map) => {
            if (val.cachedAt < cutoff) {
                map.delete(key);
            }
        });
    }
    function getLatestPdtFromM3u8(textStr) {
        if (!textStr) {
            return 0;
        }
        let latestMs = 0;
        const matches = textStr.matchAll(/#EXT-X-PROGRAM-DATE-TIME:([^\r\n]+)/g);
        for (const match of matches) {
            const ms = Date.parse(match[1].trim());
            if (!Number.isNaN(ms) && ms > latestMs) {
                latestMs = ms;
            }
        }
        return latestMs;
    }
    function hookWorkerFetch() {
        console.log('hookWorkerFetch (vaft)');
        const realFetch = fetch;
        const emptyMp4DataUri = 'data:video/mp4;base64,AAAAKGZ0eXBtcDQyAAAAAWlzb21tcDQyZGFzaGF2YzFpc282aGxzZgAABEltb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAYagAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAABqHRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAURtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAADvbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAACzc3RibAAAAGdzdHNkAAAAAAAAAAEAAABXbXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAAzZXNkcwAAAAADgICAIgABAASAgIAUQBUAAAAAAAAAAAAAAAWAgIACEZAGgICAAQIAAAAQc3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAeV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAGBbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAA9CQAAAAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABLG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAOxzdGJsAAAAoHN0c2QAAAAAAAAAAQAAAJBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAOmF2Y0MBTUAe/+EAI2dNQB6WUoFAX/LgLUBAQFAAAD6AAA6mDgAAHoQAA9CW7y4KAQAEaOuPIAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAASG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAC4AAAAAAoAAAAAAACB0cmV4AAAAAAAAAAIAAAABAACCNQAAAAACQAAA';
        fetch = async function(url, options) {
            if (typeof url === 'string') {
                if (BlockClientSideAds && (url.includes('edge.ads.twitch.tv') || url.includes('.ads.twitch.tv'))) {
                    return new Response('{}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                if (AdSegmentCache.has(url)) {
                    return realFetch(emptyMp4DataUri, options);
                }
                url = url.trimEnd();
                if (url.endsWith('m3u8')) {
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status === 200) {
                                resolve(new Response(await processM3U8(url, await response.text(), realFetch)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(function(response) {
                                processAfter(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                } else if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^\/]+)(?=\.\w+$)/)[0];
                    if (ForceAccessTokenPlayerType) {
                        // parent_domains is used to determine if the player is embedded and stripping it gets rid of fake ads
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(function(resolve, reject) {
                        const processAfter = async function(response) {
                            if (response.status == 200) {
                                const encodingsM3u8 = await response.text();
                                const serverTime = getServerTimeFromM3u8(encodingsM3u8);
                                let streamInfo = StreamInfos[channelName];
                                if (streamInfo != null && streamInfo.EncodingsM3U8 != null) {
                                    const firstM3u8Match = streamInfo.EncodingsM3U8.match(/^https:.*\.m3u8$/m);
                                    if (!firstM3u8Match || (await realFetch(firstM3u8Match[0])).status !== 200) {
                                        // The cached encodings are dead (the stream probably restarted)
                                        streamInfo = null;
                                    }
                                }
                                if (streamInfo == null || streamInfo.EncodingsM3U8 == null) {
                                    StreamInfos[channelName] = streamInfo = {
                                        ChannelName: channelName,
                                        IsShowingAd: false,
                                        LastPlayerReload: 0,
                                        EncodingsM3U8: encodingsM3u8,
                                        ModifiedM3U8: null,
                                        IsUsingModifiedM3U8: false,
                                        UsherParams: (new URL(url)).search,
                                        RequestedAds: new Set(),
                                        Urls: [],// xxx.m3u8 -> { Resolution: "284x160", FrameRate: 30.0, Codecs: "avc1...", IsPortrait: false }
                                        ResolutionList: [],
                                        BackupEncodingsM3U8Cache: [],
                                        ActiveBackupPlayerType: null,
                                        LastWorkingBackupPlayerType: null,
                                        IsMidroll: false,
                                        IsStrippingAdSegments: false,
                                        NumStrippedAdSegments: 0
                                    };
                                    const lines = encodingsM3u8.replaceAll('\r', '').split('\n');
                                    for (let i = 0; i < lines.length - 1; i++) {
                                        if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1].includes('.m3u8')) {
                                            const attributes = parseAttributes(lines[i]);
                                            const resolution = attributes['RESOLUTION'];
                                            const isPortrait = String(attributes['IVS-GROUPS'] || '').toLowerCase() === 'portrait';
                                            if (resolution) {
                                                const resolutionInfo = {
                                                    Resolution: resolution,
                                                    FrameRate: attributes['FRAME-RATE'],
                                                    Codecs: attributes['CODECS'] || 'avc1',
                                                    CodecFamily: getCodecFamily(attributes['CODECS']),
                                                    IsPortrait: isPortrait,
                                                    Url: lines[i + 1]
                                                };
                                                streamInfo.Urls[lines[i + 1]] = resolutionInfo;
                                                if (!isPortrait) {
                                                    streamInfo.ResolutionList.push(resolutionInfo);
                                                }
                                            }
                                            StreamInfosByUrl[lines[i + 1]] = streamInfo;
                                        }
                                    }
                                    const nonHevcResolutionList = streamInfo.ResolutionList.filter((element) => element.CodecFamily === 'avc');
                                    const hasAdvancedCodecs = streamInfo.ResolutionList.some((element) => element.CodecFamily === 'hevc' || element.CodecFamily === 'av1');
                                    if (AlwaysReloadPlayerOnAd || (nonHevcResolutionList.length > 0 && hasAdvancedCodecs && !SkipPlayerReloadOnHevc)) {
                                        if (nonHevcResolutionList.length > 0) {
                                            for (let i = 0; i < lines.length - 1; i++) {
                                                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                                                    const resSettings = parseAttributes(lines[i].substring(lines[i].indexOf(':') + 1));
                                                    const codecsKey = 'CODECS';
                                                    const lineCodecFamily = getCodecFamily(resSettings[codecsKey]);
                                                    if (lineCodecFamily === 'hevc' || lineCodecFamily === 'av1') {
                                                        const oldResolution = resSettings['RESOLUTION'];
                                                        const targetFrameRate = Number(resSettings['FRAME-RATE'] || 60);
                                                        const [targetWidth, targetHeight] = oldResolution.split('x').map(Number);
                                                        const newResolutionInfo = nonHevcResolutionList.slice().sort((a, b) => {
                                                            const [streamWidthA, streamHeightA] = a.Resolution.split('x').map(Number);
                                                            const [streamWidthB, streamHeightB] = b.Resolution.split('x').map(Number);
                                                            const resDiff = Math.abs((streamWidthA * streamHeightA) - (targetWidth * targetHeight)) - Math.abs((streamWidthB * streamHeightB) - (targetWidth * targetHeight));
                                                            if (resDiff !== 0) {
                                                                return resDiff;
                                                            }
                                                            return Math.abs(Number(a.FrameRate || 60) - targetFrameRate) - Math.abs(Number(b.FrameRate || 60) - targetFrameRate);
                                                        })[0];
                                                        console.log('ModifiedM3U8 swap ' + resSettings[codecsKey] + ' to ' + newResolutionInfo.Codecs + ' oldRes:' + oldResolution + ' newRes:' + newResolutionInfo.Resolution);
                                                        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${newResolutionInfo.Codecs}"`);
                                                        lines[i + 1] = newResolutionInfo.Url + ' '.repeat(i + 1);// The stream doesn't load unless each url line is unique
                                                    }
                                                }
                                            }
                                        }
                                        if (nonHevcResolutionList.length > 0 || AlwaysReloadPlayerOnAd) {
                                            streamInfo.ModifiedM3U8 = lines.join('\n');
                                        }
                                    }
                                }
                                streamInfo.LastPlayerReload = Date.now();
                                resolve(new Response(replaceServerTimeInM3u8(streamInfo.IsUsingModifiedM3U8 ? streamInfo.ModifiedM3U8 : streamInfo.EncodingsM3U8, serverTime)));
                            } else {
                                resolve(response);
                            }
                        };
                        const send = function() {
                            return realFetch(url, options).then(function(response) {
                                processAfter(response);
                            })['catch'](function(err) {
                                reject(err);
                            });
                        };
                        send();
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }
    function getServerTimeFromM3u8(encodingsM3u8) {
        if (V2API) {
            const matches = encodingsM3u8.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
            return matches && matches.length > 1 ? matches[1] : null;
        }
        const matches = encodingsM3u8.match('SERVER-TIME="([0-9.]+)"');
        return matches && matches.length > 1 ? matches[1] : null;
    }
    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (V2API) {
            return newServerTime ? encodingsM3u8.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${newServerTime}$2`) : encodingsM3u8;
        }
        return newServerTime ? encodingsM3u8.replace(new RegExp('(SERVER-TIME=")[0-9.]+"'), `SERVER-TIME="${newServerTime}"`) : encodingsM3u8;
    }
    function stripAdSegments(textStr, stripAllSegments, streamInfo, codecFamily) {
        let hasStrippedAdSegments = false;
        const lines = textStr.replaceAll('\r', '').split('\n');
        const adRanges = parseAdDateRanges(lines);
        const newAdUrl = 'https://twitch.tv';
        let currentPdtMs = null;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                const pdtStr = line.substring('#EXT-X-PROGRAM-DATE-TIME:'.length).trim();
                const ms = Date.parse(pdtStr);
                currentPdtMs = Number.isNaN(ms) ? null : Math.round(ms / 500) * 500;
            }
            // Strip client-side ad (twitch-maf-ad) and stitched-ad DATERANGE / SCTE35 markers so the player doesn't trigger the ad overlay UI
            if (line.startsWith('#EXT-X-DATERANGE:') && (line.includes(AdSignifier) || line.includes('twitch-stitched-ad') || line.includes('twitch-maf-ad') || line.includes('X-TV-TWITCH-AD-') || line.includes('SCTE35-'))) {
                hasStrippedAdSegments = true;
                lines[i] = '';
                continue;
            }
            // Remove tracking urls which appear in the overlay UI
            line = line
                .replaceAll(/(X-TV-TWITCH-AD-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`)
                .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")(?:[^"]*)(")/g, `$1${newAdUrl}$2`);
            lines[i] = line;
            const inAdRange = currentPdtMs !== null && adRanges.some(r => currentPdtMs >= r.startMs - 500 && currentPdtMs <= r.endMs + 500);
            const isDisguisedAdExtinf = line.startsWith('#EXTINF') && (!line.includes(',live') || line.includes('Amazon') || line.includes('FT|') || inAdRange);
            if (i < lines.length - 1 && line.startsWith('#EXTINF') && (isDisguisedAdExtinf || stripAllSegments || AllSegmentsAreAdSegments)) {
                const segmentUrl = lines[i + 1].trim();
                // Check if we have a live segment from the same PROGRAM-DATE-TIME in LiveSegmentCache
                const cachedLive = !stripAllSegments && !AllSegmentsAreAdSegments && currentPdtMs !== null
                    ? LiveSegmentCache.get(`${codecFamily || 'avc'}:${currentPdtMs}`)
                    : null;
                if (cachedLive && cachedLive.url) {
                    lines[i] = cachedLive.extinf;
                    lines[i + 1] = cachedLive.url;
                } else {
                    if (!AdSegmentCache.has(segmentUrl)) {
                        streamInfo.NumStrippedAdSegments++;
                    }
                    AdSegmentCache.set(segmentUrl, Date.now());
                    hasStrippedAdSegments = true;
                }
                currentPdtMs = null;
            }
            if (line.includes(AdSignifier) || line.includes('twitch-stitched-ad')) {
                hasStrippedAdSegments = true;
            }
        }
        if (hasStrippedAdSegments || adRanges.length > 0) {
            for (let i = 0; i < lines.length; i++) {
                // No low latency during ads (otherwise it's possible for the player to prefetch and display upcoming ad segments announced via B-034)
                if (lines[i].startsWith('#EXT-X-TWITCH-PREFETCH:')) {
                    const prefetchUrl = lines[i].substring('#EXT-X-TWITCH-PREFETCH:'.length).trim();
                    if (prefetchUrl) {
                        AdSegmentCache.set(prefetchUrl, Date.now());
                    }
                    lines[i] = '';
                }
            }
        } else {
            streamInfo.NumStrippedAdSegments = 0;
        }
        streamInfo.IsStrippingAdSegments = hasStrippedAdSegments;
        AdSegmentCache.forEach((value, key, map) => {
            if (value < Date.now() - 120000) {
                map.delete(key);
            }
        });
        return lines.filter((l, idx) => l !== '' || idx === lines.length - 1).join('\n');
    }
    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.replaceAll('\r', '').split('\n');
        const [targetWidth, targetHeight] = resolutionInfo.Resolution.split('x').map(Number);
        const targetFrameRate = Number(resolutionInfo.FrameRate || 60);
        const targetCodecFamily = resolutionInfo.CodecFamily || getCodecFamily(resolutionInfo.Codecs);
        const targetPortrait = Boolean(resolutionInfo.IsPortrait);
        let exactMatchUrl = null;
        let sameCodecClosestUrl = null;
        let sameCodecClosestDiff = Infinity;
        let sameCodecClosestFpsDiff = Infinity;
        let anyCodecClosestUrl = null;
        let anyCodecClosestDiff = Infinity;
        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && encodingsLines[i + 1].includes('.m3u8')) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = Number(attributes['FRAME-RATE'] || 60);
                const codecFamily = getCodecFamily(attributes['CODECS']);
                const isPortrait = String(attributes['IVS-GROUPS'] || '').toLowerCase() === 'portrait';
                if (isPortrait !== targetPortrait) {
                    continue;
                }
                if (resolution) {
                    const url = encodingsLines[i + 1];
                    const [width, height] = resolution.split('x').map(Number);
                    const difference = Math.abs((width * height) - (targetWidth * targetHeight));
                    const fpsDiff = Math.abs(frameRate - targetFrameRate);
                    if (codecFamily === targetCodecFamily) {
                        if (resolution === resolutionInfo.Resolution && fpsDiff < 1) {
                            return url;
                        }
                        if (resolution === resolutionInfo.Resolution && !exactMatchUrl) {
                            exactMatchUrl = url;
                        }
                        if (difference < sameCodecClosestDiff || (difference === sameCodecClosestDiff && fpsDiff < sameCodecClosestFpsDiff)) {
                            sameCodecClosestUrl = url;
                            sameCodecClosestDiff = difference;
                            sameCodecClosestFpsDiff = fpsDiff;
                        }
                    }
                    if (difference < anyCodecClosestDiff) {
                        anyCodecClosestUrl = url;
                        anyCodecClosestDiff = difference;
                    }
                }
            }
        }
        return exactMatchUrl || sameCodecClosestUrl || anyCodecClosestUrl;
    }
    async function prewarmBackupEncodings(channelHint) {
        try {
            const channelNames = channelHint ? [channelHint] : Object.keys(StreamInfos);
            for (const channelName of channelNames) {
                const streamInfo = StreamInfos[channelName];
                if (!streamInfo || streamInfo.IsShowingAd) {
                    continue;
                }
                const prewarmTypes = BackupPlayerTypes.slice(0, 3);
                await Promise.allSettled(prewarmTypes.map(async (playerType) => {
                    const realPlayerType = playerType.replace('-CACHED', '');
                    if (streamInfo.BackupEncodingsM3U8Cache[playerType]) {
                        return;
                    }
                    const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                    if (accessTokenResponse && accessTokenResponse.status === 200) {
                        const accessToken = await accessTokenResponse.json();
                        const tokenData = accessToken?.data?.streamPlaybackAccessToken;
                        if (tokenData) {
                            const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                            urlInfo.searchParams.set('sig', tokenData.signature);
                            urlInfo.searchParams.set('token', tokenData.value);
                            const encodingsM3u8Response = await fetch(urlInfo.href);
                            if (encodingsM3u8Response.status === 200) {
                                streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                            }
                        }
                    }
                }));
            }
        } catch (err) {}
    }
    async function fetchBackupPlaylistForType(streamInfo, playerType, currentResolution, realFetch, playerTypeIndex, isDoingMinimalRequests) {
        const realPlayerType = playerType.replace('-CACHED', '');
        const isFullyCachedPlayerType = playerType !== realPlayerType;
        const cooldownKey = `${streamInfo.ChannelName}:${playerType}`;
        const cooldownUntil = BackupPlayerCooldowns.get(cooldownKey) || 0;
        if (cooldownUntil > Date.now() && !isDoingMinimalRequests && playerType !== FallbackPlayerType) {
            return null;
        }
        for (let i = 0; i < 2; i++) {
            let isFreshM3u8 = false;
            let encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType];
            if (!encodingsM3u8) {
                isFreshM3u8 = true;
                try {
                    const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, realPlayerType);
                    if (accessTokenResponse && accessTokenResponse.status === 200) {
                        const accessToken = await accessTokenResponse.json();
                        const tokenData = accessToken?.data?.streamPlaybackAccessToken;
                        if (tokenData) {
                            const urlInfo = new URL('https://usher.ttvnw.net/api/' + (V2API ? 'v2/' : '') + 'channel/hls/' + streamInfo.ChannelName + '.m3u8' + streamInfo.UsherParams);
                            urlInfo.searchParams.set('sig', tokenData.signature);
                            urlInfo.searchParams.set('token', tokenData.value);
                            const encodingsM3u8Response = await realFetch(urlInfo.href);
                            if (encodingsM3u8Response.status === 200) {
                                encodingsM3u8 = streamInfo.BackupEncodingsM3U8Cache[playerType] = await encodingsM3u8Response.text();
                            }
                        }
                    }
                } catch (err) {}
            }
            if (encodingsM3u8) {
                try {
                    const streamM3u8Url = getStreamUrlForResolution(encodingsM3u8, currentResolution);
                    if (streamM3u8Url) {
                        const streamM3u8Response = await realFetch(streamM3u8Url);
                        if (streamM3u8Response.status === 200) {
                            const m3u8Text = await streamM3u8Response.text();
                            if (m3u8Text) {
                                cacheLiveSegmentsFromM3u8(m3u8Text, currentResolution.CodecFamily);
                                const hasAds = hasPlaylistAds(m3u8Text);
                                const isClean = !hasAds && (SimulatedAdsDepth === 0 || playerTypeIndex >= SimulatedAdsDepth - 1);
                                if (isClean || isDoingMinimalRequests) {
                                    BackupPlayerCooldowns.delete(cooldownKey);
                                    return {
                                        playerType,
                                        m3u8Text,
                                        isClean,
                                        latestPdt: getLatestPdtFromM3u8(m3u8Text),
                                        encodingsM3u8
                                    };
                                }
                                if (playerType === FallbackPlayerType) {
                                    return {
                                        playerType,
                                        m3u8Text,
                                        isClean: false,
                                        latestPdt: getLatestPdtFromM3u8(m3u8Text),
                                        encodingsM3u8
                                    };
                                }
                                if (isFullyCachedPlayerType) {
                                    break;
                                }
                            }
                        }
                    }
                } catch (err) {}
            }
            streamInfo.BackupEncodingsM3U8Cache[playerType] = null;
            if (isFreshM3u8) {
                BackupPlayerCooldowns.set(cooldownKey, Date.now() + BackupPlayerCooldownMs);
                break;
            }
        }
        return null;
    }
    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }
        if (HasTriggeredPlayerReload) {
            HasTriggeredPlayerReload = false;
            streamInfo.LastPlayerReload = Date.now();
        }
        const currentResolution = streamInfo.Urls[url];
        if (currentResolution) {
            cacheLiveSegmentsFromM3u8(textStr, currentResolution.CodecFamily);
        }
        // Strip client-side ad insertion (twitch-maf-ad) markers even when no server-side stitched ad is active
        if (BlockClientSideAds && textStr.includes('twitch-maf-ad') && !hasPlaylistAds(textStr)) {
            textStr = textStr
                .split('\n')
                .filter(line => !(line.startsWith('#EXT-X-DATERANGE:') && line.includes('twitch-maf-ad')))
                .join('\n');
        }
        const haveAdTags = hasPlaylistAds(textStr) || SimulatedAdsDepth > 0;
        if (haveAdTags) {
            streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('"midroll"');
            if (!streamInfo.IsShowingAd) {
                streamInfo.IsShowingAd = true;
                postMessage({
                    key: 'UpdateAdBlockBanner',
                    isMidroll: streamInfo.IsMidroll,
                    hasAds: streamInfo.IsShowingAd,
                    isStrippingAdSegments: false
                });
            }
            if (!streamInfo.IsMidroll) {
                const lines = textStr.replaceAll('\r', '').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (line.startsWith('#EXTINF') && lines.length > i + 1) {
                        if (!line.includes(',live') && !streamInfo.RequestedAds.has(lines[i + 1])) {
                            // Only request one .ts file per .m3u8 request to avoid making too many requests
                            streamInfo.RequestedAds.add(lines[i + 1]);
                            fetch(lines[i + 1]).then((response)=>{response.blob()});
                            break;
                        }
                    }
                }
            }
            if (!currentResolution) {
                console.log('Ads will leak due to missing resolution info for ' + url);
                return textStr;
            }
            const isAdvancedCodec = currentResolution.CodecFamily === 'hevc' || currentResolution.CodecFamily === 'av1';
            if (((isAdvancedCodec && !SkipPlayerReloadOnHevc) || AlwaysReloadPlayerOnAd) && streamInfo.ModifiedM3U8 && !streamInfo.IsUsingModifiedM3U8) {
                streamInfo.IsUsingModifiedM3U8 = true;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            }
            const mainLatestPdt = getLatestPdtFromM3u8(textStr);
            let backupPlayerType = null;
            let backupM3u8 = null;
            let fallbackM3u8 = null;
            let startIndex = 0;
            let isDoingMinimalRequests = false;
            if (streamInfo.LastPlayerReload > Date.now() - PlayerReloadMinimalRequestsTime) {
                // When doing player reload there are a lot of requests which causes the backup stream to load in slow. Briefly prefer using a single version to prevent long delays
                startIndex = Math.min(PlayerReloadMinimalRequestsPlayerIndex, BackupPlayerTypes.length - 1);
                isDoingMinimalRequests = true;
            }
            // Build prioritized list of player types (try last working backup type first during midrolls, or autoplay quickly on prerolls)
            const orderedIndices = [];
            if (!isDoingMinimalRequests && streamInfo.LastWorkingBackupPlayerType) {
                const stickyIdx = BackupPlayerTypes.indexOf(streamInfo.LastWorkingBackupPlayerType);
                if (stickyIdx >= startIndex) {
                    orderedIndices.push(stickyIdx);
                }
            }
            for (let idx = startIndex; idx < BackupPlayerTypes.length; idx++) {
                if (!orderedIndices.includes(idx)) {
                    orderedIndices.push(idx);
                }
            }
            // Step 1: Try the top priority backup player type first
            if (orderedIndices.length > 0) {
                const firstIdx = orderedIndices[0];
                const firstResult = await fetchBackupPlaylistForType(
                    streamInfo,
                    BackupPlayerTypes[firstIdx],
                    currentResolution,
                    realFetch,
                    firstIdx,
                    isDoingMinimalRequests
                );
                if (firstResult) {
                    if (firstResult.playerType === FallbackPlayerType) {
                        fallbackM3u8 = firstResult.m3u8Text;
                    }
                    if (firstResult.isClean || isDoingMinimalRequests) {
                        backupPlayerType = firstResult.playerType;
                        backupM3u8 = firstResult.m3u8Text;
                    }
                }
            }
            // Step 2: If the first backup had ads and parallel backup fetching is enabled, query remaining backup types concurrently
            if (!backupM3u8 && !isDoingMinimalRequests && orderedIndices.length > 1) {
                const remainingIndices = orderedIndices.slice(1);
                if (ParallelBackupRequests) {
                    const settled = await Promise.allSettled(
                        remainingIndices.map(idx =>
                            fetchBackupPlaylistForType(
                                streamInfo,
                                BackupPlayerTypes[idx],
                                currentResolution,
                                realFetch,
                                idx,
                                false
                            )
                        )
                    );
                    let bestCleanCandidate = null;
                    for (let i = 0; i < settled.length; i++) {
                        const res = settled[i].status === 'fulfilled' ? settled[i].value : null;
                        if (!res) {
                            continue;
                        }
                        if (res.playerType === FallbackPlayerType && !fallbackM3u8) {
                            fallbackM3u8 = res.m3u8Text;
                        }
                        if (res.isClean) {
                            // Prefer a clean backup that isn't lagging behind the player's current PDT
                            if (!bestCleanCandidate || (bestCleanCandidate.latestPdt < mainLatestPdt - 2000 && res.latestPdt >= mainLatestPdt - 2000)) {
                                bestCleanCandidate = res;
                            }
                            if (bestCleanCandidate && bestCleanCandidate.latestPdt >= mainLatestPdt - 2000) {
                                break;
                            }
                        }
                    }
                    if (bestCleanCandidate) {
                        backupPlayerType = bestCleanCandidate.playerType;
                        backupM3u8 = bestCleanCandidate.m3u8Text;
                    }
                } else {
                    for (const idx of remainingIndices) {
                        const res = await fetchBackupPlaylistForType(
                            streamInfo,
                            BackupPlayerTypes[idx],
                            currentResolution,
                            realFetch,
                            idx,
                            false
                        );
                        if (res) {
                            if (res.playerType === FallbackPlayerType && !fallbackM3u8) {
                                fallbackM3u8 = res.m3u8Text;
                            }
                            if (res.isClean) {
                                backupPlayerType = res.playerType;
                                backupM3u8 = res.m3u8Text;
                                break;
                            }
                        }
                    }
                }
            }
            if (!backupM3u8 && fallbackM3u8) {
                backupPlayerType = FallbackPlayerType;
                backupM3u8 = fallbackM3u8;
            }
            if (backupM3u8) {
                textStr = backupM3u8;
                if (!hasPlaylistAds(backupM3u8)) {
                    streamInfo.LastWorkingBackupPlayerType = backupPlayerType;
                }
                if (streamInfo.ActiveBackupPlayerType != backupPlayerType) {
                    streamInfo.ActiveBackupPlayerType = backupPlayerType;
                    console.log(`Blocking${(streamInfo.IsMidroll ? ' midroll ' : ' ')}ads (${backupPlayerType})`);
                }
            }
            const stripCodecMismatch = isAdvancedCodec && Boolean(streamInfo.ModifiedM3U8);
            if (IsAdStrippingEnabled || stripCodecMismatch) {
                textStr = stripAdSegments(textStr, stripCodecMismatch, streamInfo, currentResolution.CodecFamily);
            }
        } else if (streamInfo.IsShowingAd) {
            console.log('Finished blocking ads');
            streamInfo.IsShowingAd = false;
            streamInfo.IsStrippingAdSegments = false;
            streamInfo.NumStrippedAdSegments = 0;
            streamInfo.ActiveBackupPlayerType = null;
            if (streamInfo.IsUsingModifiedM3U8 || ReloadPlayerAfterAd) {
                streamInfo.IsUsingModifiedM3U8 = false;
                streamInfo.LastPlayerReload = Date.now();
                postMessage({
                    key: 'ReloadPlayer'
                });
            } else {
                postMessage({
                    key: 'PauseResumePlayer'
                });
            }
        }
        postMessage({
            key: 'UpdateAdBlockBanner',
            isMidroll: streamInfo.IsMidroll,
            hasAds: streamInfo.IsShowingAd,
            isStrippingAdSegments: streamInfo.IsStrippingAdSegments,
            numStrippedAdSegments: streamInfo.NumStrippedAdSegments
        });
        return textStr;
    }
    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
            .filter(Boolean)
            .map(x => {
                const idx = x.indexOf('=');
                const key = x.substring(0, idx);
                const value = x.substring(idx + 1);
                const num = Number(value);
                return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
            }));
    }
    function getPlatformForPlayerType(playerType) {
        if (playerType === 'autoplay') {
            return 'android';
        }
        if (playerType === 'embed') {
            return 'site';
        }
        return 'web';
    }
    function getAccessToken(channelName, playerType) {
        const body = {
            operationName: 'PlaybackAccessToken',
            variables: {
                isLive: true,
                login: channelName,
                isVod: false,
                vodID: "",
                playerType: playerType,
                platform: getPlatformForPlayerType(playerType)
            },
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: "ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9"
                }
            }
        };
        return gqlRequest(body, playerType);
    }
    function gqlRequest(body, playerType) {
        if (!GQLDeviceID) {
            GQLDeviceID = '';
            const dcharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
            const dcharactersLength = dcharacters.length;
            for (let i = 0; i < 32; i++) {
                GQLDeviceID += dcharacters.charAt(Math.floor(Math.random() * dcharactersLength));
            }
        }
        let headers = {
            'Client-ID': ClientID,
            'X-Device-Id': GQLDeviceID,
            'Device-ID': GQLDeviceID,
            'Authorization': AuthorizationHeader,
            ...(ClientIntegrityHeader && {'Client-Integrity': ClientIntegrityHeader}),
            ...(ClientVersion && {'Client-Version': ClientVersion}),
            ...(ClientSession && {'Client-Session-Id': ClientSession})
        };
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(2, 15);
            const fetchRequest = {
                id: requestId,
                url: 'https://gql.twitch.tv/gql',
                options: {
                    method: 'POST',
                    body: JSON.stringify(body),
                    headers
                }
            };
            pendingFetchRequests.set(requestId, {
                resolve,
                reject
            });
            postMessage({
                key: 'FetchRequest',
                value: fetchRequest
            });
        });
    }
    let playerForMonitoringBuffering = null;
    const playerBufferState = {
        channelName: null,
        hasStreamStarted: false,
        position: 0,
        bufferedPosition: 0,
        bufferDuration: 0,
        numSame: 0,
        lastFixTime: 0,
        isLive: true
    };
    function monitorPlayerBuffering() {
        if (playerForMonitoringBuffering) {
            try {
                const player = playerForMonitoringBuffering.player;
                const state = playerForMonitoringBuffering.state;
                if (!player.core) {
                    playerForMonitoringBuffering = null;
                } else if (state.props?.content?.type === 'live' && !player.isPaused() && !player.getHTMLVideoElement()?.ended && playerBufferState.lastFixTime <= Date.now() - PlayerBufferingMinRepeatDelay && !isActivelyStrippingAds) {
                    const m3u8Url = player.core?.state?.path;
                    if (m3u8Url) {
                        const fileName = new URL(m3u8Url).pathname.split('/').pop();
                        if (fileName?.endsWith('.m3u8')) {
                            const channelName = fileName.slice(0, -5);
                            if (playerBufferState.channelName != channelName) {
                                playerBufferState.channelName = channelName;
                                playerBufferState.hasStreamStarted = false;
                                playerBufferState.numSame = 0;
                            }
                        }
                    }
                    if (player.getState() === 'Playing') {
                        playerBufferState.hasStreamStarted = true;
                    }
                    const position = player.core?.state?.position;
                    const bufferedPosition = player.core?.state?.bufferedPosition;
                    const bufferDuration = player.getBufferDuration();
                    if (position != null && bufferedPosition != null) {
                        if (playerBufferState.hasStreamStarted &&
                            (!PlayerBufferingPrerollCheckEnabled || position > PlayerBufferingPrerollCheckOffset) &&
                            (playerBufferState.position == position || bufferDuration < PlayerBufferingDangerZone) &&
                            playerBufferState.bufferedPosition == bufferedPosition &&
                            playerBufferState.bufferDuration >= bufferDuration &&
                            (position != 0 || bufferedPosition != 0 || bufferDuration != 0)
                        ) {
                            playerBufferState.numSame++;
                            if (playerBufferState.numSame == PlayerBufferingSameStateCount) {
                                console.log('Attempt to fix buffering position:' + playerBufferState.position + ' bufferedPosition:' + playerBufferState.bufferedPosition + ' bufferDuration:' + playerBufferState.bufferDuration);
                                const isPausePlay = !PlayerBufferingDoPlayerReload;
                                const isReload = PlayerBufferingDoPlayerReload;
                                doTwitchPlayerTask(isPausePlay, isReload);
                                playerBufferState.lastFixTime = Date.now();
                                playerBufferState.numSame = 0;
                            }
                        } else {
                            playerBufferState.numSame = 0;
                        }
                        playerBufferState.position = position;
                        playerBufferState.bufferedPosition = bufferedPosition;
                        playerBufferState.bufferDuration = bufferDuration;
                    } else {
                        playerBufferState.numSame = 0;
                    }
                }
            } catch (err) {
                console.error('error when monitoring player for buffering: ' + err);
                playerForMonitoringBuffering = null;
            }
        }
        if (!playerForMonitoringBuffering) {
            const playerAndState = getPlayerAndState();
            if (playerAndState && playerAndState.player && playerAndState.state) {
                playerForMonitoringBuffering = {
                    player: playerAndState.player,
                    state: playerAndState.state
                };
            }
        }
        const isLive = playerForMonitoringBuffering?.state?.props?.content?.type === 'live';
        if (playerBufferState.isLive && !isLive) {
            updateAdblockBanner({
                hasAds: false
            });
        }
        playerBufferState.isLive = isLive;
        const nextDelay = playerBufferState.numSame > 0 ? PlayerBufferingFoundDelay : PlayerBufferingDelay;
        setTimeout(monitorPlayerBuffering, nextDelay);
    }
    function updateAdblockBanner(data) {
        const playerRootDiv = document.querySelector('.video-player');
        if (playerRootDiv != null) {
            let adBlockDiv = playerRootDiv.querySelector('.adblock-overlay');
            if (adBlockDiv == null) {
                adBlockDiv = document.createElement('div');
                adBlockDiv.className = 'adblock-overlay';
                adBlockDiv.innerHTML = '<div class="player-adblock-notice" style="color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px; z-index: 9999;"><p></p></div>';
                adBlockDiv.style.display = 'none';
                adBlockDiv.P = adBlockDiv.querySelector('p');
                playerRootDiv.appendChild(adBlockDiv);
            }
            if (adBlockDiv != null) {
                isActivelyStrippingAds = data.isStrippingAdSegments;
                adBlockDiv.P.textContent = 'Blocking' + (data.isMidroll ? ' midroll' : '') + ' ads' + (data.isStrippingAdSegments ? ' (stripping)' : '');
                adBlockDiv.style.display = data.hasAds && playerBufferState.isLive ? 'block' : 'none';
            }
        }
    }
    function getPlayerAndState() {
        function findReactNode(root, constraint) {
            if (root.stateNode && constraint(root.stateNode)) {
                return root.stateNode;
            }
            let node = root.child;
            while (node) {
                const result = findReactNode(node, constraint);
                if (result) {
                    return result;
                }
                node = node.sibling;
            }
            return null;
        }
        function findReactRootNode() {
            let reactRootNode = null;
            const rootNode = document.querySelector('#root');
            if (rootNode && rootNode._reactRootContainer && rootNode._reactRootContainer._internalRoot && rootNode._reactRootContainer._internalRoot.current) {
                reactRootNode = rootNode._reactRootContainer._internalRoot.current;
            }
            if (reactRootNode == null && rootNode != null) {
                const containerName = Object.keys(rootNode).find(x => x.startsWith('__reactContainer'));
                if (containerName != null) {
                    reactRootNode = rootNode[containerName];
                }
            }
            return reactRootNode;
        }
        const reactRootNode = findReactRootNode();
        if (!reactRootNode) {
            return null;
        }
        let player = findReactNode(reactRootNode, node => node.setPlayerActive && node.props && node.props.mediaPlayerInstance);
        player = player && player.props && player.props.mediaPlayerInstance ? player.props.mediaPlayerInstance : null;
        if (player?.playerInstance) {
            player = player.playerInstance;
        }
        const playerState = findReactNode(reactRootNode, node => node.setSrc && node.setInitialPlaybackSettings);
        return {
            player: player,
            state: playerState
        };
    }
    function doTwitchPlayerTask(isPausePlay, isReload) {
        const playerAndState = getPlayerAndState();
        if (!playerAndState) {
            console.log('Could not find react root');
            return;
        }
        const player = playerAndState.player;
        const playerState = playerAndState.state;
        if (!player) {
            console.log('Could not find player');
            return;
        }
        if (!playerState) {
            console.log('Could not find player state');
            return;
        }
        if (player.isPaused() || player.core?.paused) {
            return;
        }
        playerBufferState.lastFixTime = Date.now();
        playerBufferState.numSame = 0;
        if (isPausePlay) {
            player.pause();
            player.play();
            return;
        }
        if (isReload) {
            const lsKeyQuality = 'video-quality';
            const lsKeyMuted = 'video-muted';
            const lsKeyVolume = 'volume';
            let currentQualityLS = null;
            let currentMutedLS = null;
            let currentVolumeLS = null;
            try {
                currentQualityLS = localStorage.getItem(lsKeyQuality);
                currentMutedLS = localStorage.getItem(lsKeyMuted);
                currentVolumeLS = localStorage.getItem(lsKeyVolume);
                if (localStorageHookFailed && player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({default:player.core.state.muted}));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (localStorageHookFailed && player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({default:player.core.state.quality.group}));
                }
            } catch {}
            console.log('Reloading Twitch player');
            playerState.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            postTwitchWorkerMessage('TriggeredPlayerReload');
            player.play();
            if (localStorageHookFailed && (currentQualityLS || currentMutedLS || currentVolumeLS)) {
                setTimeout(() => {
                    try {
                        if (currentQualityLS) {
                            localStorage.setItem(lsKeyQuality, currentQualityLS);
                        }
                        if (currentMutedLS) {
                            localStorage.setItem(lsKeyMuted, currentMutedLS);
                        }
                        if (currentVolumeLS) {
                            localStorage.setItem(lsKeyVolume, currentVolumeLS);
                        }
                    } catch {}
                }, 3000);
            }
            return;
        }
    }
    window.reloadTwitchPlayer = () => {
        doTwitchPlayerTask(false, true);
    };
    function postTwitchWorkerMessage(key, value) {
        twitchWorkers.forEach((worker) => {
            worker.postMessage({key: key, value: value});
        });
    }
    async function handleWorkerFetchRequest(fetchRequest) {
        try {
            const response = await window.realFetch(fetchRequest.url, fetchRequest.options);
            const responseBody = await response.text();
            const responseObject = {
                id: fetchRequest.id,
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
                body: responseBody
            };
            return responseObject;
        } catch (error) {
            return {
                id: fetchRequest.id,
                error: error.message
            };
        }
    }
    function getHeaderValue(headers, key) {
        if (!headers) {
            return undefined;
        }
        if (typeof headers.get === 'function') {
            return headers.get(key) || undefined;
        }
        const lowerKey = key.toLowerCase();
        for (const k of Object.keys(headers)) {
            if (k.toLowerCase() === lowerKey) {
                return headers[k];
            }
        }
        return undefined;
    }
    function hookFetch() {
        const realFetch = window.fetch;
        window.realFetch = realFetch;
        window.fetch = function(url, init, ...args) {
            const reqUrl = typeof url === 'string' ? url : (url && typeof url.url === 'string' ? url.url : '');
            if (reqUrl) {
                // Block client-side ad server (CSAI) requests with a clean local response
                if (BlockClientSideAds && (reqUrl.includes('edge.ads.twitch.tv') || reqUrl.includes('.ads.twitch.tv'))) {
                    return Promise.resolve(new Response('{}', {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    }));
                }
                if (reqUrl.includes('gql')) {
                    const headers = init?.headers;
                    let deviceId = getHeaderValue(headers, 'X-Device-Id') || getHeaderValue(headers, 'Device-ID');
                    if (typeof deviceId === 'string' && GQLDeviceID != deviceId) {
                        GQLDeviceID = deviceId;
                        postTwitchWorkerMessage('UpdateDeviceId', GQLDeviceID);
                    }
                    const clientVersion = getHeaderValue(headers, 'Client-Version');
                    if (typeof clientVersion === 'string' && clientVersion !== ClientVersion) {
                        postTwitchWorkerMessage('UpdateClientVersion', ClientVersion = clientVersion);
                    }
                    const clientSession = getHeaderValue(headers, 'Client-Session-Id');
                    if (typeof clientSession === 'string' && clientSession !== ClientSession) {
                        postTwitchWorkerMessage('UpdateClientSession', ClientSession = clientSession);
                    }
                    const clientIntegrity = getHeaderValue(headers, 'Client-Integrity');
                    if (typeof clientIntegrity === 'string' && clientIntegrity !== ClientIntegrityHeader) {
                        postTwitchWorkerMessage('UpdateClientIntegrityHeader', ClientIntegrityHeader = clientIntegrity);
                    }
                    const authHeader = getHeaderValue(headers, 'Authorization');
                    if (typeof authHeader === 'string' && authHeader !== AuthorizationHeader) {
                        postTwitchWorkerMessage('UpdateAuthorizationHeader', AuthorizationHeader = authHeader);
                    }
                    // Reject picture-by-picture mini-player token requests locally and pre-warm worker backup tokens (Twitch requests PbP 3-14s before midrolls)
                    if (init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken') && init.body.includes('picture-by-picture')) {
                        let channelLogin = null;
                        try {
                            const parsed = JSON.parse(init.body);
                            const item = Array.isArray(parsed) ? parsed.find(x => x?.operationName === 'PlaybackAccessToken') : parsed;
                            channelLogin = item?.variables?.login || null;
                        } catch {}
                        postTwitchWorkerMessage('PrewarmBackups', channelLogin);
                        const emptyTokenPayload = JSON.stringify({
                            data: {
                                streamPlaybackAccessToken: null
                            }
                        });
                        return Promise.resolve(new Response(emptyTokenPayload, {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' }
                        }));
                    }
                    // Intercept GQL client-side ad tracking / commercial break telemetry if present in batched queries
                    if (BlockClientSideAds && init && typeof init.body === 'string' && (init.body.includes('RecordAdEvent') || init.body.includes('ClientSideAdInsertion'))) {
                        try {
                            const parsedBody = JSON.parse(init.body);
                            if (!Array.isArray(parsedBody)) {
                                return Promise.resolve(new Response(JSON.stringify({ data: {} }), {
                                    status: 200,
                                    headers: { 'Content-Type': 'application/json' }
                                }));
                            }
                        } catch {}
                    }
                    if (ForceAccessTokenPlayerType && init && typeof init.body === 'string' && init.body.includes('PlaybackAccessToken')) {
                        let replacedPlayerType = '';
                        try {
                            const newBody = JSON.parse(init.body);
                            if (Array.isArray(newBody)) {
                                for (let i = 0; i < newBody.length; i++) {
                                    if (newBody[i]?.variables?.playerType && newBody[i]?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                        replacedPlayerType = newBody[i].variables.playerType;
                                        newBody[i].variables.playerType = ForceAccessTokenPlayerType;
                                    }
                                }
                            } else {
                                if (newBody?.variables?.playerType && newBody?.variables?.playerType !== ForceAccessTokenPlayerType) {
                                    replacedPlayerType = newBody.variables.playerType;
                                    newBody.variables.playerType = ForceAccessTokenPlayerType;
                                }
                            }
                            if (replacedPlayerType) {
                                console.log(`Replaced '${replacedPlayerType}' player type with '${ForceAccessTokenPlayerType}' player type`);
                                init.body = JSON.stringify(newBody);
                            }
                        } catch {}
                    }
                }
            }
            return realFetch.apply(this, arguments);
        };
        // Also intercept XHR requests to edge.ads.twitch.tv used by Twitch CSAI
        try {
            const realXhrOpen = XMLHttpRequest.prototype.open;
            const realXhrSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url) {
                this._vaftUrl = typeof url === 'string' ? url : '';
                return realXhrOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function() {
                if (BlockClientSideAds && this._vaftUrl && (this._vaftUrl.includes('edge.ads.twitch.tv') || this._vaftUrl.includes('.ads.twitch.tv'))) {
                    Object.defineProperty(this, 'status', { get: () => 200 });
                    Object.defineProperty(this, 'readyState', { get: () => 4 });
                    Object.defineProperty(this, 'responseText', { get: () => '{}' });
                    Object.defineProperty(this, 'response', { get: () => '{}' });
                    setTimeout(() => {
                        this.dispatchEvent(new Event('readystatechange'));
                        this.dispatchEvent(new Event('load'));
                        this.dispatchEvent(new Event('loadend'));
                    }, 0);
                    return;
                }
                return realXhrSend.apply(this, arguments);
            };
        } catch {}
    }
    function onContentLoaded() {
        // Counter Twitch's 2026 commercial break focus/visibility/blur detection ("Hey, come back! This commercial break can't play while you're away")
        try {
            Object.defineProperty(document, 'visibilityState', {
                get() {
                    return 'visible';
                }
            });
        } catch {}
        let hidden = document.__lookupGetter__('hidden');
        let webkitHidden = document.__lookupGetter__('webkitHidden');
        try {
            Object.defineProperty(document, 'hidden', {
                get() {
                    return false;
                }
            });
        } catch {}
        try {
            Document.prototype.hasFocus = function() {
                return true;
            };
            document.hasFocus = function() {
                return true;
            };
        } catch {}
        const block = e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };
        let wasVideoPlaying = true;
        const visibilityChange = e => {
            const isChrome = typeof chrome !== 'undefined';
            const videos = document.getElementsByTagName('video');
            if (videos.length > 0) {
                if ((hidden && hidden.apply(document) === true) || (webkitHidden && webkitHidden.apply(document) === true)) {
                    wasVideoPlaying = !videos[0].paused && !videos[0].ended;
                } else {
                    if (!playerBufferState.hasStreamStarted) {
                        playerBufferState.hasStreamStarted = true;
                    }
                    if (isChrome && wasVideoPlaying && !videos[0].ended && videos[0].paused && videos[0].muted) {
                        videos[0].play();
                    }
                }
            }
            block(e);
        };
        document.addEventListener('visibilitychange', visibilityChange, true);
        document.addEventListener('webkitvisibilitychange', visibilityChange, true);
        document.addEventListener('mozvisibilitychange', visibilityChange, true);
        document.addEventListener('hasFocus', block, true);
        window.addEventListener('blur', block, true);
        document.addEventListener('blur', block, true);
        try {
            if (/Firefox/.test(navigator.userAgent)) {
                Object.defineProperty(document, 'mozHidden', {
                    get() {
                        return false;
                    }
                });
            } else {
                Object.defineProperty(document, 'webkitHidden', {
                    get() {
                        return false;
                    }
                });
            }
        } catch {}
        // Hooks for preserving volume / resolution
        try {
            const keysToCache = [
                'video-quality',
                'video-muted',
                'volume',
                'lowLatencyModeEnabled',// Low Latency
                'persistenceEnabled',// Mini Player
            ];
            const cachedValues = new Map();
            for (let i = 0; i < keysToCache.length; i++) {
                cachedValues.set(keysToCache[i], localStorage.getItem(keysToCache[i]));
            }
            const realSetItem = localStorage.setItem;
            localStorage.setItem = function(key, value) {
                if (cachedValues.has(key)) {
                    cachedValues.set(key, value);
                }
                realSetItem.apply(this, arguments);
            };
            const realGetItem = localStorage.getItem;
            localStorage.getItem = function(key) {
                if (cachedValues.has(key)) {
                    return cachedValues.get(key);
                }
                return realGetItem.apply(this, arguments);
            };
            if (!localStorage.getItem.toString().includes(Object.keys({cachedValues})[0])) {
                // These hooks are useful to preserve player state on player reload
                // Firefox doesn't allow hooking of localStorage functions but chrome does
                localStorageHookFailed = true;
            }
        } catch (err) {
            console.log('localStorageHooks failed ' + err);
            localStorageHookFailed = true;
        }
    }
    declareOptions(window);
    hookWindowWorker();
    hookFetch();
    if (PlayerBufferingFix) {
        monitorPlayerBuffering();
    }
    if (document.readyState === "complete" || document.readyState === "loaded" || document.readyState === "interactive") {
        onContentLoaded();
    } else {
        window.addEventListener("DOMContentLoaded", function() {
            onContentLoaded();
        });
    }
    window.simulateAds = (depth) => {
        if (depth === undefined || depth < 0) {
            console.log('Ad depth paramter required (0 = no simulated ad, 1+ = use backup player for given depth)');
            return;
        }
        postTwitchWorkerMessage('SimulateAds', depth);
    };
    window.allSegmentsAreAdSegments = () => {
        postTwitchWorkerMessage('AllSegmentsAreAdSegments');
    };
})();
