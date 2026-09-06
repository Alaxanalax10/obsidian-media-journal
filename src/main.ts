import { App, Notice, Plugin, ItemView, WorkspaceLeaf, MarkdownView, PluginSettingTab, Setting, normalizePath } from 'obsidian';

const VIEW_TYPE_VIDEO_RECORDER = 'video-recorder-view';

// --- Settings Interfaces ---
interface VideoJournalSettings {
    saveFolder: string;
}

const DEFAULT_SETTINGS: VideoJournalSettings = {
    saveFolder: 'Video Journals'
}

export default class VideoJournalPlugin extends Plugin {
    settings: VideoJournalSettings;

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new VideoJournalSettingTab(this.app, this));
        this.registerView(VIEW_TYPE_VIDEO_RECORDER, (leaf) => new VideoRecorderView(leaf, this));

        this.addRibbonIcon('camera', 'Open Media Recorder', () => {
            this.activateView();
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_VIDEO_RECORDER);
        
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if(leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_VIDEO_RECORDER, active: true });
            }
        }
        
        if (leaf) workspace.revealLeaf(leaf);
    }
}

// --- The UI View ---
class VideoRecorderView extends ItemView {
    plugin: VideoJournalPlugin;
    
    mediaRecorder: MediaRecorder | null = null;
    recordedChunks: BlobPart[] = [];
    videoElement: HTMLVideoElement;
    stream: MediaStream | null = null;
    isMediaOn = false;

    elapsedSeconds = 0;
    timerInterval: number | null = null;
    timerDisplay: HTMLElement;
    
    // UI Elements
    sourceSelect: HTMLSelectElement;
    mediaToggleBtn: HTMLButtonElement;
    recordBtn: HTMLButtonElement;
    pauseBtn: HTMLButtonElement;
    stopBtn: HTMLButtonElement;
    pipBtn: HTMLButtonElement;
    qualitySelect: HTMLSelectElement;
    embedCheckbox: HTMLInputElement;
    muteCheckbox: HTMLInputElement;

    constructor(leaf: WorkspaceLeaf, plugin: VideoJournalPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE_VIDEO_RECORDER; }
    getDisplayText() { return 'Media Recorder'; }
    getIcon() { return 'camera'; }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        
        // Compact Header: Title and Timer on the same line
        const headerRow = container.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px;' } });
        headerRow.createEl('h4', { text: 'Media Recorder', attr: { style: 'margin: 0;' }});
        this.timerDisplay = headerRow.createDiv({ 
            text: '00:00', 
            attr: { style: 'font-size: 1.2em; font-family: monospace; font-weight: bold; color: var(--text-error);' } 
        });

        // Small Controls right above the video
        const previewControls = container.createDiv({ attr: { style: 'display: flex; justify-content: space-between; gap: 5px; margin-bottom: 5px;' } });
        this.mediaToggleBtn = previewControls.createEl('button', { text: 'Turn on Camera', attr: { style: 'font-size: 0.8em; padding: 4px 8px; height: auto; flex: 1;' } });
        this.pipBtn = previewControls.createEl('button', { text: 'PiP', attr: { disabled: true, style: 'font-size: 0.8em; padding: 4px 8px; height: auto;' } });

        // Video Preview (Compact)
        this.videoElement = container.createEl('video', { 
            attr: { autoplay: true, style: 'width: 100%; border-radius: 6px; background: #222; min-height: 120px; max-height: 200px;' } 
        });

        // Settings Container (Reduced gaps)
        const settingsDiv = container.createDiv({ attr: { style: 'margin-top: 8px; display: flex; flex-direction: column; gap: 4px; font-size: 0.85em;' } });
        
        // Source Dropdown
        const sourceDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        sourceDiv.createSpan({ text: 'Source:' });
        this.sourceSelect = sourceDiv.createEl('select', { attr: { style: 'padding: 2px 5px;' }});
        this.sourceSelect.createEl('option', { value: 'camera', text: 'Webcam' });
        this.sourceSelect.createEl('option', { value: 'screen', text: 'Screen Capture' });
        this.sourceSelect.createEl('option', { value: 'audio', text: 'Audio Only' });
        
        this.sourceSelect.onchange = () => {
            this.updateToggleButtonText();
            if (this.isMediaOn) this.initMedia();
        };

        // Quality Dropdown
        const qualityDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        qualityDiv.createSpan({ text: 'Quality:' });
        this.qualitySelect = qualityDiv.createEl('select', { attr: { style: 'padding: 2px 5px;' }});
        this.qualitySelect.createEl('option', { value: 'low', text: 'Low' });
        this.qualitySelect.createEl('option', { value: 'normal', text: 'Normal', attr: { selected: true }});
        this.qualitySelect.createEl('option', { value: 'high', text: 'High' });
        
        this.qualitySelect.onchange = () => {
            if (this.isMediaOn && this.sourceSelect.value === 'camera') this.initMedia();
        };

        // Embed Toggle
        const embedDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        embedDiv.createSpan({ text: 'Embed in note:' });
        this.embedCheckbox = embedDiv.createEl('input', { type: 'checkbox' });
        this.embedCheckbox.checked = true;

        // Mute Preview Toggle
        const muteDiv = settingsDiv.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center;' }});
        muteDiv.createSpan({ text: 'Mute preview (no echo):' });
        this.muteCheckbox = muteDiv.createEl('input', { type: 'checkbox' });
        this.muteCheckbox.checked = true; 

        this.videoElement.muted = this.muteCheckbox.checked;
        this.videoElement.volume = this.muteCheckbox.checked ? 0 : 1;
        this.muteCheckbox.onchange = () => {
            this.videoElement.muted = this.muteCheckbox.checked;
            this.videoElement.volume = this.muteCheckbox.checked ? 0 : 1;
        };

        // Record Controls
        const controlsDiv = container.createDiv({ attr: { style: 'margin-top: 10px; display: flex; flex-direction: column; gap: 5px;' } });
        const topRow = controlsDiv.createDiv({ attr: { style: 'display: flex; gap: 5px;' } });
        this.recordBtn = topRow.createEl('button', { text: 'Record', attr: { disabled: true, style: 'flex: 1;' }});
        this.pauseBtn = topRow.createEl('button', { text: 'Pause', attr: { disabled: true, style: 'flex: 1;' }});
        this.stopBtn = controlsDiv.createEl('button', { text: 'Stop & Save', attr: { disabled: true }});

        this.setupEventListeners();
    }

    updateToggleButtonText() {
        if (this.isMediaOn) {
            this.mediaToggleBtn.innerText = 'Turn off';
        } else {
            const source = this.sourceSelect.value;
            if (source === 'camera') this.mediaToggleBtn.innerText = 'Turn on Camera';
            else if (source === 'screen') this.mediaToggleBtn.innerText = 'Preview Screen';
            else if (source === 'audio') this.mediaToggleBtn.innerText = 'Test Mic';
        }
    }

    async initMedia() {
        this.stopMedia(); // Clear existing

        const source = this.sourceSelect.value;
        const quality = this.qualitySelect.value;
        let videoConstraints: MediaTrackConstraints | boolean = {};

        if (quality === 'low') videoConstraints = { width: 640, height: 480 };
        else if (quality === 'normal') videoConstraints = { width: 1280, height: 720 };
        else if (quality === 'high') videoConstraints = { width: 1920, height: 1080 };

        try {
            if (source === 'audio') {
                this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                // FIXED: Use setCssStyles instead of static style assignment
                this.videoElement.setCssStyles({ display: 'none' });
            } else if (source === 'screen') {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                
                const combinedTracks = [...screenStream.getVideoTracks(), ...micStream.getAudioTracks()];
                this.stream = new MediaStream(combinedTracks);
                
                // FIXED: Use setCssStyles instead of static style assignment
                this.videoElement.setCssStyles({ display: 'block' });
                this.videoElement.srcObject = this.stream;
            } else {
                this.stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: true });
                // FIXED: Use setCssStyles instead of static style assignment
                this.videoElement.setCssStyles({ display: 'block' });
                this.videoElement.srcObject = this.stream;
            }

            this.isMediaOn = true;
            this.updateToggleButtonText();
            this.recordBtn.disabled = false;
            this.pipBtn.disabled = source === 'audio';
            
        } catch (err) {
            new Notice('Media access denied or canceled.');
            this.isMediaOn = false;
            this.updateToggleButtonText();
        }
    }

    stopMedia() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        this.videoElement.srcObject = null;
        this.isMediaOn = false;
        this.updateToggleButtonText();
        this.recordBtn.disabled = true;
        this.pipBtn.disabled = true;
        
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        }
    }

    setupEventListeners() {
        this.mediaToggleBtn.onclick = async () => {
            if (this.isMediaOn) this.stopMedia();
            else await this.initMedia();
        };

        this.pipBtn.onclick = async () => {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else {
                await this.videoElement.requestPictureInPicture();
            }
        };

        this.recordBtn.onclick = () => {
            if (!this.stream) return;
            
            this.recordedChunks = [];
            const source = this.sourceSelect.value;
            const quality = this.qualitySelect.value;
            
            let videoBitsPerSecond = 1000000; 
            if (quality === 'low') videoBitsPerSecond = 250000; 
            if (quality === 'high') videoBitsPerSecond = 2500000; 

            const mimeType = source === 'audio' ? 'audio/webm' : 'video/webm';
            
            this.mediaRecorder = new MediaRecorder(this.stream, {
                mimeType: mimeType,
                videoBitsPerSecond: source === 'audio' ? undefined : videoBitsPerSecond
            });
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) this.recordedChunks.push(event.data);
            };

            this.mediaRecorder.onstop = async () => {
                const blob = new Blob(this.recordedChunks, { type: mimeType });
                await this.saveMediaToVault(blob, source);
            };

            this.mediaRecorder.start();
            this.resetTimer();
            this.startTimer();
            
            this.recordBtn.disabled = true;
            this.sourceSelect.disabled = true;
            this.mediaToggleBtn.disabled = true; 
            this.qualitySelect.disabled = true; 
            this.pauseBtn.disabled = false;
            this.stopBtn.disabled = false;
        };

        this.pauseBtn.onclick = () => {
            if (!this.mediaRecorder) return;
            if (this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.pause();
                this.stopTimer();
                this.pauseBtn.innerText = 'Resume';
            } else if (this.mediaRecorder.state === 'paused') {
                this.mediaRecorder.resume();
                this.startTimer();
                this.pauseBtn.innerText = 'Pause';
            }
        };

        this.stopBtn.onclick = () => {
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }
            this.stopTimer();
            this.stopMedia();
            
            this.recordBtn.disabled = true;
            this.mediaToggleBtn.disabled = false;
            this.sourceSelect.disabled = false;
            this.qualitySelect.disabled = false;
            this.pauseBtn.disabled = true;
            this.pauseBtn.innerText = 'Pause';
            this.stopBtn.disabled = true;
        };
    }

    // Timer methods
    updateTimerDisplay() {
        const minutes = Math.floor(this.elapsedSeconds / 60).toString().padStart(2, '0');
        const seconds = (this.elapsedSeconds % 60).toString().padStart(2, '0');
        this.timerDisplay.innerText = `${minutes}:${seconds}`;
    }
    startTimer() {
        if (this.timerInterval !== null) return;
        this.timerInterval = window.setInterval(() => {
            this.elapsedSeconds++;
            this.updateTimerDisplay();
        }, 1000);
    }
    stopTimer() {
        if (this.timerInterval !== null) {
            window.clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }
    resetTimer() {
        this.stopTimer();
        this.elapsedSeconds = 0;
        this.updateTimerDisplay();
    }

    async saveMediaToVault(blob: Blob, source: string) {
        const arrayBuffer = await blob.arrayBuffer();
        const timestamp = window.moment().format('YYYYMMDD-HHmmss');
        
        const prefix = source === 'audio' ? 'Audio' : (source === 'screen' ? 'Screen' : 'Video');
        const filename = `${prefix}-Reflection-${timestamp}.webm`;
        
        const folderPath = normalizePath(this.plugin.settings.saveFolder);
        
        try {
            if (folderPath && folderPath !== "/") {
                const folderExists = this.app.vault.getAbstractFileByPath(folderPath);
                if (!folderExists) {
                    await this.app.vault.createFolder(folderPath);
                }
            }

            const finalPath = (folderPath && folderPath !== "/") ? `${folderPath}/${filename}` : filename;
            await this.app.vault.createBinary(finalPath, arrayBuffer);
            new Notice(`Saved to ${finalPath}!`);

            if (this.embedCheckbox.checked) {
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (activeView) {
                    const editor = activeView.editor;
                    const cursor = editor.getCursor();
                    const embedText = `\n![[${finalPath}]]\n`;
                    editor.replaceRange(embedText, cursor);
                    editor.setCursor({ line: cursor.line + 2, ch: 0 });
                }
            }
        } catch (error) {
            new Notice('Failed to save media.');
            console.error(error);
        }
    }

    async onClose() {
        this.stopTimer();
        this.stopMedia();
    }
}

// --- The Settings Tab ---
class VideoJournalSettingTab extends PluginSettingTab {
    plugin: VideoJournalPlugin;

    constructor(app: App, plugin: VideoJournalPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();
        
        // FIXED: Use Obsidian's Setting API instead of creating raw h2 elements for UI consistency
        new Setting(containerEl).setName('Video Journal Settings').setHeading();

        new Setting(containerEl)
            .setName('Save Folder')
            .setDesc('Folder where your recordings will be saved.')
            .addText(text => text
                .setPlaceholder('Enter folder path')
                .setValue(this.plugin.settings.saveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.saveFolder = value;
                    await this.plugin.saveSettings();
                }));
    }
}