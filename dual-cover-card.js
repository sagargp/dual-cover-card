class DualCoverCard extends HTMLElement {
  setConfig(config) {
    if (!config.top_cover || !config.bottom_cover) {
      throw new Error('Please define top_cover and bottom_cover');
    }
    this.config = config;
    // If switching back to "set on release", clear any pending (un-applied) positions.
    if (this._isSetOnReleaseMode()) {
      this._clearPendingPositions();
    }
    // Force update when config changes
    if (this._hass) {
      this.hass = this._hass;
    }
  }

  set hass(hass) {
    // Prevent recursive calls
    if (this._updating) {
      return;
    }

    this._updating = true;

    try {
      if (!this.content) {
        const card = document.createElement('ha-card');
        // Only show title if show_title is not false
        if (this.config.show_title !== false) {
          card.header = this.config.name || 'Dual Cover';
        }
        this.content = document.createElement('div');
        this.content.style.padding = '16px';
        card.appendChild(this.content);
        this.appendChild(card);
      }

      const topState = hass.states[this.config.top_cover];
      const bottomState = hass.states[this.config.bottom_cover];

      if (!topState || !bottomState) {
        this.content.innerHTML = `
          <hui-warning>
            ${!topState ? `Top cover entity not found: ${this.config.top_cover}` : ''}
            ${!bottomState ? `Bottom cover entity not found: ${this.config.bottom_cover}` : ''}
          </hui-warning>
        `;
        this._updating = false;
        return;
      }

      const topPositionFromState = topState.attributes.current_position ?? 0;
      const bottomPositionFromState = bottomState.attributes.current_position ?? 0;

      // Robust "moving" detection:
      // - Some cover platforms don't set state=opening/closing or attributes.moving reliably.
      // - Some also don't update current_position while moving (only at the end).
      // We combine:
      //   (a) explicit HA state flags, (b) observed position deltas (needs >=2 updates to trigger), and
      //   (c) "commanded motion" tracking when THIS card calls services.
      const now = Date.now();
      const movingByState =
        topState.state === 'opening' ||
        topState.state === 'closing' ||
        topState.attributes?.moving === true ||
        bottomState.state === 'opening' ||
        bottomState.state === 'closing' ||
        bottomState.attributes?.moving === true;

      if (!this._motionTracker) {
        this._motionTracker = {
          lastTop: topPositionFromState,
          lastBottom: bottomPositionFromState,
          lastChangeTs: now,
          prevChangeTs: 0,
          deltaMovingUntil: 0,
          stableTop: topPositionFromState,
          stableBottom: bottomPositionFromState,
          targets: {},
          commandedUntil: 0,
        };
      }

      const posChanged =
        this._motionTracker.lastTop !== topPositionFromState || this._motionTracker.lastBottom !== bottomPositionFromState;
      if (posChanged) {
        this._motionTracker.lastChangeTs = now;
        this._motionTracker.lastTop = topPositionFromState;
        this._motionTracker.lastBottom = bottomPositionFromState;
        // Only treat delta-based movement as "moving" once we see >=2 position changes close together.
        if (this._motionTracker.prevChangeTs && now - this._motionTracker.prevChangeTs < 2500) {
          this._motionTracker.deltaMovingUntil = Math.max(this._motionTracker.deltaMovingUntil, now + 2500);
        }
        this._motionTracker.prevChangeTs = now;
      }

      const movingByDelta = now < this._motionTracker.deltaMovingUntil;
      const hasTargets = this._motionTracker.targets && Object.keys(this._motionTracker.targets).length > 0;
      const movingByCommand = hasTargets && now < this._motionTracker.commandedUntil;

      // Clear completed targets when position reaches requested target (best-effort).
      if (hasTargets && !movingByState) {
        const within = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1;
        const topTarget = this._motionTracker.targets[this.config.top_cover];
        const bottomTarget = this._motionTracker.targets[this.config.bottom_cover];
        if (topTarget !== undefined && within(topPositionFromState, topTarget)) {
          delete this._motionTracker.targets[this.config.top_cover];
        }
        if (bottomTarget !== undefined && within(bottomPositionFromState, bottomTarget)) {
          delete this._motionTracker.targets[this.config.bottom_cover];
        }
        if (Object.keys(this._motionTracker.targets).length === 0) {
          this._motionTracker.commandedUntil = 0;
        }
      }

      // Safety: don't get stuck forever if completion can't be detected.
      if (hasTargets && now >= this._motionTracker.commandedUntil) {
        this._motionTracker.targets = {};
      }

      const isMoving = movingByState || movingByDelta || movingByCommand;

      const isManualSet = !this._isSetOnReleaseMode();

      // While moving, freeze the displayed positions to the last stable ones so the spinner feels "steady",
      // then snap to final positions when motion completes.
      if (!isMoving) {
        this._motionTracker.stableTop = topPositionFromState;
        this._motionTracker.stableBottom = bottomPositionFromState;
      }

      const topPosition = isManualSet && this._pendingTopSet
        ? this._pendingTop
        : (isMoving ? this._motionTracker.stableTop : topPositionFromState);
      const bottomPosition = isManualSet && this._pendingBottomSet
        ? this._pendingBottom
        : (isMoving ? this._motionTracker.stableBottom : bottomPositionFromState);

      // Store hass reference for event handlers
      this._hass = hass;

      // Don't update if we're currently dragging (prevents infinite loop)
      if (this._dragState && this._dragState.isDragging) {
        this._updating = false;
        return;
      }

      // Compute config-driven values that affect rendering even when positions don't change.
      const sliderWidth = parseInt(this.config.width, 10) || 56;
      // show_background controls the *CARD* background, not the slider.
      const showCardBackgroundValue = this.config.show_background;
      const shouldShowCardBackground =
        showCardBackgroundValue !== false && showCardBackgroundValue !== 'false' && showCardBackgroundValue !== 0;
      // Optional: allow a separate slider background flag; default to true to preserve existing visuals.
      const showSliderBackgroundValue = this.config.show_slider_background;
      const shouldShowSliderBackground =
        showSliderBackgroundValue === undefined ||
        (showSliderBackgroundValue !== false && showSliderBackgroundValue !== 'false' && showSliderBackgroundValue !== 0);
      const showTitle = this.config.show_title !== false;
      const headerName = this.config.name || 'Dual Cover';
      const topInfoLabel = this.config.top_label || 'Top';
      const bottomInfoLabel = this.config.bottom_label || 'Bottom';
      const showInfo = this.config.show_info !== false;
      const showStop = this.config.show_stop === true || this.config.show_stop === 'true' || this.config.show_stop === 1;
      const manualSetMode = isManualSet;

      // Only skip DOM work if *nothing* relevant changed (positions + config-driven render values).
      const hasSlider = !!this.content.querySelector('.cover-slider-container');
      const canSkip =
        hasSlider &&
        this._topPosition === topPosition &&
        this._bottomPosition === bottomPosition &&
        this._lastSliderWidth === sliderWidth &&
        this._lastShouldShowCardBackground === shouldShowCardBackground &&
        this._lastShouldShowSliderBackground === shouldShowSliderBackground &&
        this._lastShowInfo === showInfo &&
        this._lastManualSetMode === manualSetMode &&
        this._lastShowStop === showStop &&
        this._lastIsMoving === isMoving &&
        this._lastShowTitle === showTitle &&
        this._lastHeaderName === headerName &&
        this._lastTopInfoLabel === topInfoLabel &&
        this._lastBottomInfoLabel === bottomInfoLabel;

      if (canSkip) {
        this._updating = false;
        return;
      }

      this._topPosition = topPosition;
      this._bottomPosition = bottomPosition;
      this._lastSliderWidth = sliderWidth;
      this._lastShouldShowCardBackground = shouldShowCardBackground;
      this._lastShouldShowSliderBackground = shouldShowSliderBackground;
      this._lastShowInfo = showInfo;
      this._lastManualSetMode = manualSetMode;
      this._lastShowStop = showStop;
      this._lastIsMoving = isMoving;
      this._lastShowTitle = showTitle;
      this._lastHeaderName = headerName;
      this._lastTopInfoLabel = topInfoLabel;
      this._lastBottomInfoLabel = bottomInfoLabel;

    // Create style element if it doesn't exist
    if (!this.styleEl) {
      this.styleEl = document.createElement('style');
      this.styleEl.textContent = `
        .dual-cover-wrapper {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
        }
        .cover-slider-container {
          position: relative;
          height: 300px;
          margin: 16px 0;
          border: 2px solid var(--divider-color);
          border-radius: 8px;
          box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
          overflow: hidden;
          background: transparent;
        }
        .cover-slider-container.with-background {
          background: var(--card-background-color);
        }
        .cover-slider-track {
          position: absolute;
          left: 0;
          right: 0;
          top: 0;
          bottom: 0;
          width: 100%;
          background: var(--disabled-color);
        }
        .cover-slider-fill {
          position: absolute;
          left: 0;
          right: 0;
          width: 100%;
          background: var(--primary-color);
          opacity: 0.3;
          transition: top 0.1s, bottom 0.1s;
        }
        .cover-handle {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          width: 80%;
          height: 8px;
          border-radius: 4px;
          background: var(--primary-color);
          border: 2px solid var(--card-background-color);
          cursor: grab;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          z-index: 2;
        }
        .cover-handle:active {
          cursor: grabbing;
        }
        .cover-handle.top-handle {
          margin-top: -4px;
        }
        .cover-handle.bottom-handle {
          margin-top: -4px;
        }
        .cover-handle::before {
          content: '';
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          width: 60%;
          height: 2px;
          background: rgba(255, 255, 255, 0.5);
          border-radius: 1px;
        }
        .cover-position-label {
          position: absolute;
          left: 50%;
          transform: translateX(-50%);
          font-size: 11px;
          color: var(--primary-text-color);
          background: var(--card-background-color);
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
          margin-top: -8px;
          pointer-events: none;
        }
        .cover-controls {
          display: flex;
          gap: 24px;
          align-items: center;
        }
        .cover-busy-overlay {
          position: absolute;
          left: 0;
          right: 0;
          top: 0;
          bottom: 0;
          display: none;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.06);
          z-index: 3;
          /* Block interaction while moving */
          pointer-events: auto;
          cursor: wait;
        }
        .cover-busy-overlay.active {
          display: flex;
        }
        .cover-busy-spinner {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          border: 3px solid rgba(0, 0, 0, 0.2);
          border-top-color: var(--primary-color);
          animation: dualCoverSpin 1s linear infinite;
          box-sizing: border-box;
        }
        @keyframes dualCoverSpin {
          to { transform: rotate(360deg); }
        }
        .cover-info {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          min-width: 80px;
        }
        .cover-info-label {
          font-size: 12px;
          color: var(--secondary-text-color);
          text-transform: uppercase;
        }
        .cover-info-value {
          font-size: 16px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
      `;
      this.content.appendChild(this.styleEl);
    }

    // Create container
    let wrapper = this.content.querySelector('.dual-cover-wrapper');
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.className = 'dual-cover-wrapper';
      this.content.appendChild(wrapper);
    }

    // Create slider container
    let sliderContainer = wrapper.querySelector('.cover-slider-container');
    if (!sliderContainer) {
      sliderContainer = document.createElement('div');
      sliderContainer.className = 'cover-slider-container';
      if (shouldShowSliderBackground) {
        sliderContainer.classList.add('with-background');
      }
      sliderContainer.style.width = `${sliderWidth}px`;
      wrapper.appendChild(sliderContainer);

      // Create track
      const track = document.createElement('div');
      track.className = 'cover-slider-track';
      sliderContainer.appendChild(track);

      // Create fill
      const fill = document.createElement('div');
      fill.className = 'cover-slider-fill';
      sliderContainer.appendChild(fill);

      // Busy overlay (spinner) shown while covers are moving
      const busyOverlay = document.createElement('div');
      busyOverlay.className = 'cover-busy-overlay';
      const spinner = document.createElement('div');
      spinner.className = 'cover-busy-spinner';
      busyOverlay.appendChild(spinner);
      sliderContainer.appendChild(busyOverlay);

      // Create top handle
      const topHandle = document.createElement('div');
      topHandle.className = 'cover-handle top-handle';
      topHandle.setAttribute('data-handle', 'top');
      sliderContainer.appendChild(topHandle);

      // Create bottom handle
      const bottomHandle = document.createElement('div');
      bottomHandle.className = 'cover-handle bottom-handle';
      bottomHandle.setAttribute('data-handle', 'bottom');
      sliderContainer.appendChild(bottomHandle);

      // Create position labels
      const topLabel = document.createElement('div');
      topLabel.className = 'cover-position-label top-label';
      sliderContainer.appendChild(topLabel);

      const bottomLabel = document.createElement('div');
      bottomLabel.className = 'cover-position-label bottom-label';
      sliderContainer.appendChild(bottomLabel);

      // Add drag handlers (only once)
      if (!sliderContainer.hasAttribute('data-handlers-setup')) {
        this._setupDragHandlers(sliderContainer, topHandle, bottomHandle, fill, topLabel, bottomLabel);
        sliderContainer.setAttribute('data-handlers-setup', 'true');
      }
    } else {
      // Always update width when config changes
      sliderContainer.style.width = `${sliderWidth}px`;
      // Update background class based on config
      if (shouldShowSliderBackground) {
        sliderContainer.classList.add('with-background');
      } else {
        sliderContainer.classList.remove('with-background');
      }
    }

    // Toggle busy overlay based on moving state
    const overlay = sliderContainer.querySelector('.cover-busy-overlay');
    if (overlay) {
      if (isMoving) overlay.classList.add('active');
      else overlay.classList.remove('active');
    }

    // Update card header if show_title changed
    const card = this.querySelector('ha-card');
    if (card) {
      // Apply card background toggle (without altering inner widget styling).
      if (shouldShowCardBackground) {
        card.style.background = '';
        card.style.boxShadow = '';
        card.style.border = '';
        card.style.outline = '';
      } else {
        card.style.background = 'transparent';
        card.style.boxShadow = 'none';
        // Some themes draw an outline/border on ha-card; hide it when background is off.
        card.style.border = 'none';
        card.style.outline = 'none';
      }
      if (showTitle) {
        card.header = headerName;
      } else {
        card.header = '';
      }
    }

    // Update positions
    this._updateSliderPositions(sliderContainer, topPosition, bottomPosition);

    // Create info displays
    let controls = wrapper.querySelector('.cover-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'cover-controls';
      wrapper.appendChild(controls);
      // Hide/show the info block without affecting other widget styling/layout.
      controls.style.display = showInfo ? '' : 'none';

      // Top info
      const topInfo = document.createElement('div');
      topInfo.className = 'cover-info';
      topInfo.innerHTML = `
        <div class="cover-info-label">${topInfoLabel}</div>
        <div class="cover-info-value top-value">${topPosition}%</div>
      `;
      controls.appendChild(topInfo);

      // Bottom info
      const bottomInfo = document.createElement('div');
      bottomInfo.className = 'cover-info';
      bottomInfo.innerHTML = `
        <div class="cover-info-label">${bottomInfoLabel}</div>
        <div class="cover-info-value bottom-value">${bottomPosition}%</div>
      `;
      controls.appendChild(bottomInfo);
    } else {
      controls.style.display = showInfo ? '' : 'none';

      // Update values
      const topValue = controls.querySelector('.top-value');
      const bottomValue = controls.querySelector('.bottom-value');
      if (topValue) topValue.textContent = `${topPosition}%`;
      if (bottomValue) bottomValue.textContent = `${bottomPosition}%`;

      // Update labels if config changed
      const labelEls = controls.querySelectorAll('.cover-info-label');
      const topLabelEl = labelEls[0];
      const bottomLabelEl = labelEls[1];
      if (topLabelEl) topLabelEl.textContent = topInfoLabel;
      if (bottomLabelEl) bottomLabelEl.textContent = bottomInfoLabel;
    }

    // When NOT setting positions on release, show Set/Reset buttons in a separate area.
    // Also optionally show a Stop button (even if Set/Reset are hidden).
    this._ensureActionsArea(wrapper, manualSetMode, showStop);
    } finally {
      this._updating = false;
    }
  }

  _isSetOnReleaseMode() {
    const v = this.config?.set_on_release;
    // Default true
    if (v === undefined) return true;
    return v === true || v === 'true' || v === 1;
  }

  _clearPendingPositions() {
    this._pendingTopSet = false;
    this._pendingBottomSet = false;
    this._pendingTop = undefined;
    this._pendingBottom = undefined;
  }

  _ensureActionsArea(wrapper, manualSetMode, showStop) {
    let actions = wrapper.querySelector('.dual-cover-actions');
    // Show actions row if we need manual Set/Reset OR if Stop is enabled.
    if (!manualSetMode && !showStop) {
      if (actions) actions.remove();
      return;
    }

    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'dual-cover-actions';
      // Minimal styling: only ensure spacing between the buttons.
      wrapper.appendChild(actions);
    }
    actions.style.display = 'flex';
    actions.style.gap = '8px';

    let setBtn = actions.querySelector('.dual-cover-set-button');
    let resetBtn = actions.querySelector('.dual-cover-reset-button');
    let stopBtn = actions.querySelector('.dual-cover-stop-button');

    // Set/Reset only relevant in manual mode (set_on_release: false).
    if (manualSetMode) {
      if (!setBtn) {
        setBtn = this._createActionButton('Set');
        setBtn.className = 'dual-cover-set-button';
        if (!setBtn.hasAttribute('data-set-handler')) {
          setBtn.addEventListener('click', () => this._applyPendingPositions());
          setBtn.setAttribute('data-set-handler', 'true');
        }
        actions.appendChild(setBtn);
      }

      if (!resetBtn) {
        resetBtn = this._createActionButton('Reset');
        resetBtn.className = 'dual-cover-reset-button';
        if (!resetBtn.hasAttribute('data-reset-handler')) {
          resetBtn.addEventListener('click', () => this._resetPendingPositions());
          resetBtn.setAttribute('data-reset-handler', 'true');
        }
        actions.appendChild(resetBtn);
      }
    } else {
      // Ensure buttons are removed when switching back to set_on_release mode.
      if (setBtn) setBtn.remove();
      if (resetBtn) resetBtn.remove();
    }

    // Stop button (optional): always in the same row.
    if (showStop) {
      if (!stopBtn) {
        stopBtn = this._createActionButton('Stop');
        stopBtn.className = 'dual-cover-stop-button';
        if (!stopBtn.hasAttribute('data-stop-handler')) {
          stopBtn.addEventListener('click', () => this._stopCovers());
          stopBtn.setAttribute('data-stop-handler', 'true');
        }
        actions.appendChild(stopBtn);
      }
    } else if (stopBtn) {
      stopBtn.remove();
    }
  }

  _createActionButton(label) {
    // Prefer HA-provided buttons when available (match theme), otherwise fall back.
    if (customElements.get('ha-button')) {
      const el = document.createElement('ha-button');
      // ha-button typically supports "label" as a property; keep textContent as fallback.
      try {
        el.label = label;
      } catch (e) {
        // ignore
      }
      el.textContent = label;
      return el;
    }
    if (customElements.get('mwc-button')) {
      const el = document.createElement('mwc-button');
      el.setAttribute('label', label);
      el.textContent = label;
      return el;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    return el;
  }

  _applyPendingPositions() {
    if (!this._hass) return;
    if (this._pendingTopSet) {
      this._setPosition(this.config.top_cover, this._pendingTop);
    }
    if (this._pendingBottomSet) {
      this._setPosition(this.config.bottom_cover, this._pendingBottom);
    }
    // Clear pending flags; keep current UI positions until hass state updates.
    this._clearPendingPositions();
  }

  _resetPendingPositions() {
    // Discard pending (unapplied) positions and re-sync UI from current HA state.
    this._clearPendingPositions();
    if (this._hass) {
      this.hass = this._hass;
    }
  }

  _stopCovers() {
    if (!this._hass) return;
    const top = this.config?.top_cover;
    const bottom = this.config?.bottom_cover;
    if (top) {
      this._hass.callService('cover', 'stop_cover', { entity_id: top });
    }
    if (bottom) {
      this._hass.callService('cover', 'stop_cover', { entity_id: bottom });
    }
    // Stop should end motion; clear spinner state immediately.
    if (this._motionTracker) {
      this._motionTracker.targets = {};
      this._motionTracker.commandedUntil = 0;
    }
    this.hass = this._hass;
  }

  _updateSliderPositions(container, topPos, bottomPos) {
    const topHandle = container.querySelector('.top-handle');
    const bottomHandle = container.querySelector('.bottom-handle');
    const fill = container.querySelector('.cover-slider-fill');
    const topLabel = container.querySelector('.top-label');
    const bottomLabel = container.querySelector('.bottom-label');

    const containerHeight = 300;
    const handleSize = 8; // Height of the handle bar
    const minHandleGap = handleSize + 6; // 6px buffer between handles (no overlap, no crossing)
    // Prevent the bottom handle from reaching the very top so it's always grabbable when fully open.
    // This does not change styling; it only changes the bottom handle's usable range.
    const bottomMinY = handleSize + 6;
    const maxY = containerHeight - handleSize;
    // Prevent the top handle from reaching the very bottom so it's always grabbable when fully closed.
    const topMaxY = Math.max(1, maxY - (handleSize + 6));

    // Convert percentage to pixels (0% = closed/bottom, 100% = open/top)
    // Invert so higher percentage = higher on screen (closer to top)
    const topY = ((100 - topPos) / 100) * topMaxY;
    const bottomRange = Math.max(1, maxY - bottomMinY);
    const bottomY = bottomMinY + ((100 - bottomPos) / 100) * bottomRange;

    // Enforce ordering + minimum gap so handles never overlap/cross visually.
    let adjTopY = Math.max(0, Math.min(topY, topMaxY));
    let adjBottomY = Math.max(bottomMinY, Math.min(bottomY, maxY));
    if (adjBottomY - adjTopY < minHandleGap) {
      const mid = (adjTopY + adjBottomY) / 2;
      adjTopY = mid - minHandleGap / 2;
      adjBottomY = mid + minHandleGap / 2;

      // Clamp while preserving gap.
      if (adjTopY < 0) {
        adjTopY = 0;
        adjBottomY = adjTopY + minHandleGap;
      }
      if (adjBottomY > maxY) {
        adjBottomY = maxY;
        adjTopY = adjBottomY - minHandleGap;
      }
      if (adjBottomY < bottomMinY) {
        adjBottomY = bottomMinY;
        adjTopY = adjBottomY - minHandleGap;
      }
      if (adjTopY > topMaxY) {
        adjTopY = topMaxY;
        adjBottomY = adjTopY + minHandleGap;
      }
      // Final clamp
      adjTopY = Math.max(0, Math.min(adjTopY, topMaxY));
      adjBottomY = Math.max(bottomMinY, Math.min(adjBottomY, maxY));
    }

    if (topHandle) {
      topHandle.style.top = `${adjTopY}px`;
    }
    if (bottomHandle) {
      bottomHandle.style.top = `${adjBottomY}px`;
    }

    // Update fill (between handles)
    if (fill) {
      const fillTop = Math.min(adjTopY, adjBottomY);
      const fillBottom = Math.max(adjTopY, adjBottomY);
      fill.style.top = `${fillTop + handleSize / 2}px`;
      fill.style.bottom = `${containerHeight - fillBottom - handleSize / 2}px`;
    }

    // Update labels
    if (topLabel) {
      topLabel.style.top = `${adjTopY}px`;
      topLabel.textContent = `${topPos}%`;
    }
    if (bottomLabel) {
      bottomLabel.style.top = `${adjBottomY}px`;
      bottomLabel.textContent = `${bottomPos}%`;
    }
  }

  _setupDragHandlers(container, topHandle, bottomHandle, fill, topLabel, bottomLabel) {
    // Store drag state on the card instance, not in closure
    if (!this._dragState) {
      this._dragState = {
        isDragging: false,
        dragHandle: null,
        dragType: null, // 'top' | 'bottom' | 'both'
        startY: 0,
        startPosition: 0,
        startTopPosition: 0,
        startBottomPosition: 0,
      };
    }

    const containerHeight = 300;
    const handleSize = 8; // Height of the handle bar
    const bottomMinY = handleSize + 6;
    const maxY = containerHeight - handleSize;
    const topMaxY = Math.max(1, maxY - (handleSize + 6));
    const minHandleGap = handleSize + 6;
    const self = this;

    const startDrag = (e, handle) => {
      self._dragState.isDragging = true;
      self._dragState.dragHandle = handle;
      self._dragState.dragType = handle.classList.contains('top-handle') ? 'top' : 'bottom';
      self._dragState.startY = e.clientY || e.touches[0].clientY;
      const handleY = parseFloat(handle.style.top) || 0;
      self._dragState.startPosition = handleY;
      e.preventDefault();
      e.stopPropagation();
    };

    const startDragBoth = (e) => {
      self._dragState.isDragging = true;
      self._dragState.dragHandle = null;
      self._dragState.dragType = 'both';
      self._dragState.startY = e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY);
      self._dragState.startTopPosition = parseFloat(topHandle.style.top) || 0;
      self._dragState.startBottomPosition = parseFloat(bottomHandle.style.top) || 0;
      e.preventDefault();
      e.stopPropagation();
    };

    const drag = (e) => {
      if (!self._dragState.isDragging) return;

      const currentY = e.clientY || (e.touches && e.touches[0] && e.touches[0].clientY);
      if (!currentY) return;

      const deltaY = currentY - self._dragState.startY;

      // Drag BOTH handles when grabbing the shaded area between them.
      if (self._dragState.dragType === 'both') {
        const startTopY = self._dragState.startTopPosition;
        const startBottomY = self._dragState.startBottomPosition;
        // Clamp delta so both handles stay within bounds, respecting bottom's minimum.
        const minDelta = Math.max(-startTopY, bottomMinY - startBottomY);
        const maxDelta = Math.min(topMaxY - startTopY, maxY - startBottomY);
        const clampedDelta = Math.max(minDelta, Math.min(deltaY, maxDelta));
        const newTopY = startTopY + clampedDelta;
        const newBottomY = startBottomY + clampedDelta;

        topHandle.style.top = `${newTopY}px`;
        bottomHandle.style.top = `${newBottomY}px`;

        const topPct = Math.round(100 - (newTopY / topMaxY) * 100);
        const bottomRange = Math.max(1, maxY - bottomMinY);
        const bottomPct = Math.round(100 - ((newBottomY - bottomMinY) / bottomRange) * 100);
        self._topPosition = topPct;
        self._bottomPosition = bottomPct;

        topLabel.textContent = `${topPct}%`;
        topLabel.style.top = `${newTopY}px`;
        bottomLabel.textContent = `${bottomPct}%`;
        bottomLabel.style.top = `${newBottomY}px`;

        const fillTop = Math.min(newTopY, newBottomY);
        const fillBottom = Math.max(newTopY, newBottomY);
        fill.style.top = `${fillTop + handleSize / 2}px`;
        fill.style.bottom = `${containerHeight - fillBottom - handleSize / 2}px`;

        const controls = self.content.querySelector('.cover-controls');
        if (controls) {
          const topValue = controls.querySelector('.top-value');
          const bottomValue = controls.querySelector('.bottom-value');
          if (topValue) topValue.textContent = `${topPct}%`;
          if (bottomValue) bottomValue.textContent = `${bottomPct}%`;
        }
        return;
      }

      // Otherwise drag a single handle (existing behavior).
      if (!self._dragState.dragHandle) return;

      let newY = self._dragState.startPosition + deltaY;
      if (self._dragState.dragType === 'bottom') {
        const topY = parseFloat(topHandle.style.top) || 0;
        const minY = Math.max(bottomMinY, topY + minHandleGap);
        newY = Math.max(minY, Math.min(newY, maxY));
      } else if (self._dragState.dragType === 'top') {
        const bottomY = parseFloat(bottomHandle.style.top) || maxY;
        const maxAllowed = Math.min(topMaxY, bottomY - minHandleGap);
        newY = Math.max(0, Math.min(newY, maxAllowed));
      } else {
        newY = Math.max(0, Math.min(newY, maxY));
      }

      const percentage =
        self._dragState.dragType === 'bottom'
          ? Math.round(100 - ((newY - bottomMinY) / Math.max(1, maxY - bottomMinY)) * 100)
          : self._dragState.dragType === 'top'
            ? Math.round(100 - (newY / topMaxY) * 100)
            : Math.round(100 - (newY / maxY) * 100);
      self._dragState.dragHandle.style.top = `${newY}px`;

      if (self._dragState.dragType === 'top') {
        self._topPosition = percentage;
        topLabel.textContent = `${percentage}%`;
        topLabel.style.top = `${newY}px`;
      } else {
        self._bottomPosition = percentage;
        bottomLabel.textContent = `${percentage}%`;
        bottomLabel.style.top = `${newY}px`;
      }

      const topY = self._dragState.dragType === 'top' ? newY : parseFloat(topHandle.style.top) || 0;
      const bottomY = self._dragState.dragType === 'bottom' ? newY : parseFloat(bottomHandle.style.top) || 0;
      const fillTop = Math.min(topY, bottomY);
      const fillBottom = Math.max(topY, bottomY);
      fill.style.top = `${fillTop + handleSize / 2}px`;
      fill.style.bottom = `${containerHeight - fillBottom - handleSize / 2}px`;

      const controls = self.content.querySelector('.cover-controls');
      if (controls) {
        const topValue = controls.querySelector('.top-value');
        const bottomValue = controls.querySelector('.bottom-value');
        if (topValue && self._dragState.dragType === 'top') topValue.textContent = `${percentage}%`;
        if (bottomValue && self._dragState.dragType === 'bottom') bottomValue.textContent = `${percentage}%`;
      }
    };

    const stopDrag = () => {
      // Make service call only on release
      const isManualSet = !self._isSetOnReleaseMode();

      if (self._dragState.dragType === 'both') {
        const topY = parseFloat(topHandle.style.top) || 0;
        const bottomY = parseFloat(bottomHandle.style.top) || 0;
        const topPct = Math.round(100 - (topY / topMaxY) * 100);
        const bottomRange = Math.max(1, maxY - bottomMinY);
        const bottomPct = Math.round(100 - ((bottomY - bottomMinY) / bottomRange) * 100);

        if (isManualSet) {
          self._pendingTop = topPct;
          self._pendingBottom = bottomPct;
          self._pendingTopSet = true;
          self._pendingBottomSet = true;
        } else {
          self._setPosition(self.config.top_cover, topPct);
          self._setPosition(self.config.bottom_cover, bottomPct);
        }
      } else if (self._dragState.dragHandle) {
        const currentY = parseFloat(self._dragState.dragHandle.style.top) || 0;
        const percentage =
          self._dragState.dragType === 'bottom'
            ? Math.round(100 - ((currentY - bottomMinY) / Math.max(1, maxY - bottomMinY)) * 100)
            : self._dragState.dragType === 'top'
              ? Math.round(100 - (currentY / topMaxY) * 100)
              : Math.round(100 - (currentY / maxY) * 100);

        if (self._dragState.dragType === 'top') {
          if (isManualSet) {
            self._pendingTop = percentage;
            self._pendingTopSet = true;
          } else {
            self._setPosition(self.config.top_cover, percentage);
          }
        } else {
          if (isManualSet) {
            self._pendingBottom = percentage;
            self._pendingBottomSet = true;
          } else {
            self._setPosition(self.config.bottom_cover, percentage);
          }
        }
      }

      self._dragState.isDragging = false;
      self._dragState.dragHandle = null;
      self._dragState.dragType = null;
    };

    // Store bound functions to avoid creating new ones each time
    if (!this._dragHandlers) {
      this._dragHandlers = {
        topMouseDown: (e) => startDrag(e, topHandle),
        bottomMouseDown: (e) => startDrag(e, bottomHandle),
        topTouchStart: (e) => startDrag(e, topHandle),
        bottomTouchStart: (e) => startDrag(e, bottomHandle),
        fillMouseDown: (e) => startDragBoth(e),
        fillTouchStart: (e) => startDragBoth(e),
        mouseMove: drag,
        touchMove: drag,
        mouseUp: stopDrag,
        touchEnd: stopDrag,
      };

      topHandle.addEventListener('mousedown', this._dragHandlers.topMouseDown);
      bottomHandle.addEventListener('mousedown', this._dragHandlers.bottomMouseDown);
      topHandle.addEventListener('touchstart', this._dragHandlers.topTouchStart);
      bottomHandle.addEventListener('touchstart', this._dragHandlers.bottomTouchStart);
      if (fill) {
        fill.addEventListener('mousedown', this._dragHandlers.fillMouseDown);
        fill.addEventListener('touchstart', this._dragHandlers.fillTouchStart);
      }

      document.addEventListener('mousemove', this._dragHandlers.mouseMove);
      document.addEventListener('touchmove', this._dragHandlers.touchMove);
      document.addEventListener('mouseup', this._dragHandlers.mouseUp);
      document.addEventListener('touchend', this._dragHandlers.touchEnd);
    }
  }

  _setPosition(entityId, position) {
    if (!this._hass) return;

    // Track "commanded motion" so the spinner shows while the cover moves, even if HA doesn't update state/position during motion.
    if (!this._motionTracker) {
      const now = Date.now();
      this._motionTracker = {
        lastTop: 0,
        lastBottom: 0,
        lastChangeTs: now,
        prevChangeTs: 0,
        deltaMovingUntil: 0,
        stableTop: 0,
        stableBottom: 0,
        targets: {},
        commandedUntil: 0,
      };
    }
    if (!this._motionTracker.targets) this._motionTracker.targets = {};
    this._motionTracker.targets[entityId] = parseInt(position, 10);
    this._motionTracker.commandedUntil = Math.max(this._motionTracker.commandedUntil || 0, Date.now() + 60000);
    // Force an immediate re-render so the spinner shows right away.
    this.hass = this._hass;

    // Throttle service calls to prevent infinite loops
    const key = `${entityId}_${position}`;
    if (this._lastServiceCall === key) {
      return; // Already called with this exact value
    }

    this._lastServiceCall = key;
    this._hass.callService('cover', 'set_cover_position', {
      entity_id: entityId,
      position: parseInt(position, 10),
    });

    // Clear the throttle after a short delay
    setTimeout(() => {
      if (this._lastServiceCall === key) {
        this._lastServiceCall = null;
      }
    }, 200);
  }

  getCardSize() {
    return 4;
  }

  static getConfigElement() {
    return document.createElement('dual-cover-card-editor');
  }

  static getStubConfig() {
    return {
      top_cover: '',
      bottom_cover: '',
      name: 'Dual Cover',
      top_label: 'Top',
      bottom_label: 'Bottom',
      width: 56,
      show_title: true,
      show_background: true,
      show_info: true,
      set_on_release: true,
      show_stop: false,
    };
  }
}

class DualCoverCardEditor extends HTMLElement {
  constructor() {
    super();
    this._boundValueChanged = this._valueChanged.bind(this);
    this._rendered = false;
    this._listenersAdded = false;
  }

  setConfig(config) {
    this._config = config;
    // If we're already on-screen, update form fields without re-rendering or re-binding listeners.
    if (this._rendered) {
      this._updateFormValues();
    }
  }

  connectedCallback() {
    this._ensureRendered();
    this._applyHassToPickers();
    this._updateFormValues();
    this._setupListenersOnce();
  }

  set hass(hass) {
    this._hass = hass;
    this._applyHassToPickers();
  }

  _ensureRendered() {
    if (this._rendered) return;

    // NOTE: Keep all styling/layout exactly as-is; only behavior is adjusted below.
    this.innerHTML = `
      <div style="padding: 16px;">
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px;">Top Cover Entity:</label>
          <ha-entity-picker
            id="top-cover-picker"
          ></ha-entity-picker>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px;">Bottom Cover Entity:</label>
          <ha-entity-picker
            id="bottom-cover-picker"
          ></ha-entity-picker>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px;">Card Name (optional):</label>
          <ha-textfield
            placeholder="Dual Cover"
          ></ha-textfield>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px;">Top Label (optional):</label>
          <ha-textfield
            placeholder="Top"
          ></ha-textfield>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px;">Bottom Label (optional):</label>
          <ha-textfield
            placeholder="Bottom"
          ></ha-textfield>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px;">Slider Width (px, optional):</label>
          <ha-textfield
            type="number"
            placeholder="56"
          ></ha-textfield>
        </div>
        <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
          <ha-switch></ha-switch>
          <label>Show Title</label>
        </div>
        <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
          <ha-switch></ha-switch>
          <label>Show Background</label>
        </div>
        <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
          <ha-switch></ha-switch>
          <label>Show Info</label>
        </div>
        <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
          <ha-switch></ha-switch>
          <label>Set positions on release</label>
        </div>
        <div style="margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
          <ha-switch></ha-switch>
          <label>Show Stop</label>
        </div>
      </div>
    `;

    // Cache element refs for stable listener wiring.
    this._topPicker = this.querySelector('#top-cover-picker');
    this._bottomPicker = this.querySelector('#bottom-cover-picker');
    const textfields = this.querySelectorAll('ha-textfield');
    this._nameField = textfields[0];
    this._topLabelField = textfields[1];
    this._bottomLabelField = textfields[2];
    this._widthField = textfields[3];
    const switches = this.querySelectorAll('ha-switch');
    this._showTitleSwitch = switches[0];
    this._showBackgroundSwitch = switches[1];
    this._showInfoSwitch = switches[2];
    this._setOnReleaseSwitch = switches[3];
    this._showStopSwitch = switches[4];

    // Domain filtering must be set as a PROPERTY, not an attribute.
    if (this._topPicker) this._topPicker.includeDomains = ['cover'];
    if (this._bottomPicker) this._bottomPicker.includeDomains = ['cover'];

    // Used by _valueChanged to map input -> config key.
    if (this._topPicker) this._topPicker.configValue = 'top_cover';
    if (this._bottomPicker) this._bottomPicker.configValue = 'bottom_cover';
    if (this._nameField) this._nameField.configValue = 'name';
    if (this._topLabelField) this._topLabelField.configValue = 'top_label';
    if (this._bottomLabelField) this._bottomLabelField.configValue = 'bottom_label';
    if (this._widthField) this._widthField.configValue = 'width';
    if (this._showTitleSwitch) this._showTitleSwitch.configValue = 'show_title';
    if (this._showBackgroundSwitch) this._showBackgroundSwitch.configValue = 'show_background';
    if (this._showInfoSwitch) this._showInfoSwitch.configValue = 'show_info';
    if (this._setOnReleaseSwitch) this._setOnReleaseSwitch.configValue = 'set_on_release';
    if (this._showStopSwitch) this._showStopSwitch.configValue = 'show_stop';

    this._rendered = true;
  }

  _setupListenersOnce() {
    if (this._listenersAdded) return;
    const handler = this._boundValueChanged;

    if (this._topPicker) this._topPicker.addEventListener('change', handler);
    if (this._bottomPicker) this._bottomPicker.addEventListener('change', handler);
    if (this._nameField) this._nameField.addEventListener('change', handler);
    if (this._topLabelField) this._topLabelField.addEventListener('change', handler);
    if (this._bottomLabelField) this._bottomLabelField.addEventListener('change', handler);
    if (this._widthField) this._widthField.addEventListener('change', handler);
    if (this._showTitleSwitch) {
      this._showTitleSwitch.addEventListener('change', handler);
      this._showTitleSwitch.addEventListener('checked-changed', handler);
    }
    if (this._showBackgroundSwitch) {
      this._showBackgroundSwitch.addEventListener('change', handler);
      this._showBackgroundSwitch.addEventListener('checked-changed', handler);
    }
    if (this._showInfoSwitch) {
      this._showInfoSwitch.addEventListener('change', handler);
      this._showInfoSwitch.addEventListener('checked-changed', handler);
    }
    if (this._setOnReleaseSwitch) {
      this._setOnReleaseSwitch.addEventListener('change', handler);
      this._setOnReleaseSwitch.addEventListener('checked-changed', handler);
    }
    if (this._showStopSwitch) {
      this._showStopSwitch.addEventListener('change', handler);
      this._showStopSwitch.addEventListener('checked-changed', handler);
    }

    this._listenersAdded = true;
  }

  _applyHassToPickers() {
    // Only set hass if it's fully initialized (prevents localize-related crashes).
    if (!this._rendered) return;
    const hass = this._hass;
    if (!hass || !hass.localize) return;

    if (this._topPicker) this._topPicker.hass = hass;
    if (this._bottomPicker) this._bottomPicker.hass = hass;
  }

  _updateFormValues() {
    if (!this._rendered) return;

    const topCover = this._config?.top_cover || '';
    const bottomCover = this._config?.bottom_cover || '';
    const name = this._config?.name || '';
    const topLabel = this._config?.top_label || '';
    const bottomLabel = this._config?.bottom_label || '';
    const showTitle = this._config?.show_title !== false; // Default to true
    const showBackground = this._config?.show_background !== false; // Default to true
    const showInfo = this._config?.show_info !== false; // Default to true
    const setOnRelease = this._config?.set_on_release !== false; // Default to true
    const showStop = this._config?.show_stop === true; // Default to false

    if (this._topPicker) this._topPicker.value = topCover;
    if (this._bottomPicker) this._bottomPicker.value = bottomCover;
    if (this._nameField) this._nameField.value = name;
    if (this._topLabelField) this._topLabelField.value = topLabel;
    if (this._bottomLabelField) this._bottomLabelField.value = bottomLabel;
    if (this._widthField) this._widthField.value = this._config?.width || '';
    if (this._showTitleSwitch) this._showTitleSwitch.checked = showTitle;
    if (this._showBackgroundSwitch) this._showBackgroundSwitch.checked = showBackground;
    if (this._showInfoSwitch) this._showInfoSwitch.checked = showInfo;
    if (this._setOnReleaseSwitch) this._setOnReleaseSwitch.checked = setOnRelease;
    if (this._showStopSwitch) this._showStopSwitch.checked = showStop;
  }

  _valueChanged(ev) {
    if (!this._config) {
      this._config = {};
    }
    const target = ev.target;
    if (target.configValue) {
      let value;
      if (target.configValue === 'width') {
        value = target.value ? parseInt(target.value, 10) : 56;
      } else if (
        target.configValue === 'show_title' ||
        target.configValue === 'show_background' ||
        target.configValue === 'show_info' ||
        target.configValue === 'set_on_release' ||
        target.configValue === 'show_stop'
      ) {
        // ha-switch sometimes emits `checked-changed` with `detail.value`
        if (ev && ev.detail && typeof ev.detail.value === 'boolean') {
          value = ev.detail.value;
        } else {
          value = target.checked;
        }
      } else {
        value = target.value;
      }
      this._config[target.configValue] = value;
    }
    const event = new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }
}

customElements.define('dual-cover-card-editor', DualCoverCardEditor);
customElements.define('dual-cover-card', DualCoverCard);

console.log('%cDual Cover Card v2.27', 'color: green; font-weight: bold; font-size: 14px;');

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'dual-cover-card',
  name: 'Dual Cover Card',
  description: 'A vertical slider with two handles to control dual covers independently',
  preview: true,
  documentationURL: 'https://github.com/sagargp/dual-cover-card',
});
