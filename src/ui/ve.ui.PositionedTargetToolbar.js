/*!
 * VisualEditor UserInterface PositionedTargetToolbar class.
 *
 * @copyright 2011-2016 VisualEditor Team and others; see http://ve.mit-license.org
 */

/**
 * UserInterface positioned target toolbar.
 *
 * @class
 * @extends ve.ui.TargetToolbar
 *
 * @constructor
 * @param {ve.init.Target} target
 * @param {Object} [config] Configuration options
 * @cfg {boolean} [floatable] Toolbar can float when scrolled off the page
 */
ve.ui.PositionedTargetToolbar = function VeUiPositionedTargetToolbar( target, config ) {
	config = config || {};

	// Parent constructor
	ve.ui.PositionedTargetToolbar.super.apply( this, arguments );

	// Properties
	this.floating = false;
	this.floatable = !!config.floatable;
	this.$window = $( this.getElementWindow() );
	this.elementOffset = null;

	// Initialization
	this.$element.addClass( 've-ui-positionedTargetToolbar' );
};

/* Inheritance */

OO.inheritClass( ve.ui.PositionedTargetToolbar, ve.ui.TargetToolbar );

/* Methods */

/**
 * @inheritdoc
 */
ve.ui.PositionedTargetToolbar.prototype.setup = function () {
	// Parent method
	ve.ui.PositionedTargetToolbar.super.prototype.setup.apply( this, arguments );

	this.getSurface().getToolbarDialogs().connect( this, {
		opening: 'onToolbarDialogsOpeningOrClosing',
		closing: 'onToolbarDialogsOpeningOrClosing'
	} );
};

/**
 * @inheritdoc
 */
ve.ui.PositionedTargetToolbar.prototype.detach = function () {
	this.unfloat();

	// Events
	if ( this.getSurface() ) {
		this.getSurface().getToolbarDialogs().disconnect( this );
		this.getSurface().getToolbarDialogs().clearWindows();
	}

	// Parent method
	ve.ui.PositionedTargetToolbar.super.prototype.detach.apply( this, arguments );
};

/**
 * @inheritdoc
 *
 * While toolbar floating is enabled,
 * the toolbar will stick to the top of the screen unless it would be over or under the last visible
 * branch node in the root of the document being edited, at which point it will stop just above it.
 */
ve.ui.PositionedTargetToolbar.prototype.onWindowResize = function () {
	ve.ui.Toolbar.super.prototype.onWindowResize.call( this );

	// Update offsets after resize (see #float)
	this.calculateOffset();

	if ( this.floating ) {
		this.$bar.css( {
			left: this.elementOffset.left,
			right: this.elementOffset.right
		} );
	}

};

/**
 * Calculate the left and right offsets of the toolbar
 */
ve.ui.PositionedTargetToolbar.prototype.calculateOffset = function () {
	this.elementOffset = this.$element.offset();
	this.elementOffset.right = this.$window.width() - this.$element.outerWidth() - this.elementOffset.left;
};

/**
 * Get height of the toolbar while floating
 *
 * @return {number} Height of the toolbar
 */
ve.ui.PositionedTargetToolbar.prototype.getHeight = function () {
	return this.height;
};

/**
 * Get toolbar element's offsets
 *
 * @return {Object} Toolbar element's offsets
 */
ve.ui.PositionedTargetToolbar.prototype.getElementOffset = function () {
	if ( !this.elementOffset ) {
		this.calculateOffset();
	}
	return this.elementOffset;
};

/**
 * Float the toolbar.
 */
ve.ui.PositionedTargetToolbar.prototype.float = function () {
	if ( !this.floating ) {
		this.height = this.$element.height();
		// When switching into floating mode, set the height of the wrapper and
		// move the bar to the same offset as the in-flow element
		this.$element
			.css( 'height', this.height )
			.addClass( 've-ui-toolbar-floating' );
		this.$bar.css( {
			left: this.elementOffset.left,
			right: this.elementOffset.right
		} );
		this.floating = true;
		this.emit( 'resize' );
	}
};

/**
 * Reset the toolbar to it's default non-floating position.
 */
ve.ui.PositionedTargetToolbar.prototype.unfloat = function () {
	if ( this.floating ) {
		this.height = 0;
		this.$element
			.css( 'height', '' )
			.removeClass( 've-ui-toolbar-floating' );
		this.$bar.css( { left: '', right: '' } );
		this.floating = false;
		this.emit( 'resize' );
	}
};

/**
 * Check if the toolbar is floating
 *
 * @return {boolean} The toolbar is floating
 */
ve.ui.PositionedTargetToolbar.prototype.isFloating = function () {
	return this.floating;
};

/**
 * Check if the toolbar can float
 *
 * @return {boolean} The toolbar can float
 */
ve.ui.PositionedTargetToolbar.prototype.isFloatable = function () {
	return this.floatable;
};

/**
 * Handle windows opening or closing in the toolbar window manager.
 *
 * @param {OO.ui.Window} win
 * @param {jQuery.Promise} openingOrClosing
 * @param {Object} data
 */
ve.ui.PositionedTargetToolbar.prototype.onToolbarDialogsOpeningOrClosing = function ( win, openingOrClosing ) {
	var toolbar = this;

	openingOrClosing.then( function () {
		toolbar.updateToolState();
		// Wait for window transition
		setTimeout( function () {
			if ( toolbar.floating ) {
				// Re-calculate height
				toolbar.unfloat();
				toolbar.float();
			}
		}, 250 );
	} );
};
