/*global rangy */

/**
 * VisualEditor content editable Surface class.
 *
 * @copyright 2011-2012 VisualEditor Team and others; see AUTHORS.txt
 * @license The MIT License (MIT); see LICENSE.txt
 */

/**
 * ContentEditable surface.
 *
 * @class
 * @constructor
 * @extends {ve.EventEmitter}
 * @param {jQuery} $container
 * @param {ve.dm.Surface} model Model to observe
 * @param {ve.Surface} surface The surface of this view
 */
ve.ce.Surface = function VeCeSurface( $container, model, surface ) {
	// Parent constructor
	ve.EventEmitter.call( this );

	// Properties
	this.surface = surface;
	this.inIme = false;
	this.model = model;
	this.documentView = new ve.ce.Document( model.getDocument(), this );
	this.surfaceObserver = new ve.ce.SurfaceObserver( this.documentView );
	this.selectionTimeout = null;
	this.$ = $container;
	this.$document = $( document );
	this.clipboard = {};
	this.renderingEnabled = true;
	this.dragging = false;
	this.selecting = false;
	this.$phantoms = $( '<div class="ve-ce-phantoms">' );
	this.pasting = false;
	this.clickHistory = [];

	// Events
	this.surfaceObserver.addListenerMethods(
		this, { 'contentChange': 'onContentChange', 'selectionChange': 'onSelectionChange' }
	);
	this.model.addListenerMethods(
		this, { 'change': 'onChange', 'lock': 'onLock', 'unlock': 'onUnlock' }
	);
	this.documentView.getDocumentNode().$.on( {
		'focus': ve.bind( this.documentOnFocus, this ),
		'blur': ve.bind( this.documentOnBlur, this )
	} );
	this.$.on( {
		'cut': ve.bind( this.onCut, this ),
		'copy': ve.bind( this.onCopy, this ),
		'paste': ve.bind( this.onPaste, this ),
		'dragover drop': function ( e ) {
			// Prevent content drag & drop
			e.preventDefault();
			return false;
		}
	} );
	if ( $.browser.msie ) {
		this.$.on( 'beforepaste', ve.bind( this.onPaste, this ) );
	}

	// Initialization
	rangy.init();
	ve.ce.Surface.clearLocalStorage();
	this.$.append( this.documentView.getDocumentNode().$ );
	this.$.append( this.$phantoms );
};

/* Inheritance */

ve.inheritClass( ve.ce.Surface, ve.EventEmitter );

/* Static Members */

ve.ce.Surface.static = {};

ve.ce.Surface.static.$phantomTemplate = $( '<div class="ve-ce-phantom" draggable="false"></div>' )
	.attr( 'title', ve.msg ( 'visualeditor-aliennode-tooltip' ) );

/* Methods */

/**
 * Destroy the surface, removing all DOM elements.
 *
 * @method
 * @returns {ve.ui.Context} Context user interface
 */
ve.ce.Surface.prototype.destroy = function () {
	this.$.remove();
};

/**
 * Disables editing.
 *
 * @method
 */
ve.ce.Surface.prototype.disable = function () {
	this.documentView.getDocumentNode().disable();
};

/**
 * Enables editing.
 *
 * @method
 */
ve.ce.Surface.prototype.enable = function () {
	this.documentView.getDocumentNode().enable();
};

/**
 * Handles insertion of content.
 *
 * @method
 */
ve.ce.Surface.prototype.handleInsertion = function () {
	var slug, data, range, annotations, insertionAnnotations, placeholder,
		selection = this.model.getSelection();

	// Handles removing expanded selection before inserting new text
	if ( !selection.isCollapsed() ) {
		// Pull annotations from the first character in the selection
		annotations = this.model.documentModel.getAnnotationsFromRange(
			new ve.Range( selection.start, selection.start + 1 )
		);
		this.model.change(
			ve.dm.Transaction.newFromRemoval( this.documentView.model, selection ),
			new ve.Range( selection.start )
		);
		this.surfaceObserver.clear();
		selection = this.model.getSelection();
		this.model.setInsertionAnnotations( annotations );
	}
	insertionAnnotations = this.model.getInsertionAnnotations() || new ve.AnnotationSet();
	if ( selection.isCollapsed() ) {
		slug = this.documentView.getSlugAtOffset( selection.start );
		// Is this a slug or are the annotations to the left different than the insertion
		// annotations?
		if (
			slug || (
				selection.start > 0 &&
				!ve.compareObjects (
					this.model.getDocument().getAnnotationsFromOffset( selection.start - 1 ),
					insertionAnnotations
				)
			)
		) {
			placeholder = '\u2659';
			if ( !insertionAnnotations.isEmpty() ) {
				placeholder = [placeholder, insertionAnnotations];
			}
			// is this a slug and if so, is this a block slug?
			if ( slug && ve.dm.Document.isStructuralOffset(
				this.documentView.model.data, selection.start
			) ) {
				range = new ve.Range( selection.start + 1, selection.start + 2 );
				data = [{ 'type' : 'paragraph' }, placeholder, { 'type' : '/paragraph' }];
			} else {
				range = new ve.Range( selection.start, selection.start + 1 );
				data = [placeholder];
			}
			this.model.change(
				ve.dm.Transaction.newFromInsertion(
					this.documentView.model, selection.start, data
				),
				range
			);
			this.surfaceObserver.clear();
		}
	}

	this.surfaceObserver.stop( true );
};

/**
 * Responds to 'contentChange' events emitted in {ve.ce.SurfaceObserver.prototype.poll}.
 *
 * @method
 * @param {HTMLElement} node DOM node the change occured in
 * @param {Object} previous Old data
 * @param {Object} previous.text Old plain text content
 * @param {Object} previous.hash Old DOM hash
 * @param {Object} previous.range Old selection
 * @param {Object} next New data
 * @param {Object} next.text New plain text content
 * @param {Object} next.hash New DOM hash
 * @param {Object} next.range New selection
 */
ve.ce.Surface.prototype.onContentChange = function ( node, previous, next ) {
	var data, range, len, annotations, offsetDiff, lengthDiff, sameLeadingAndTrailing,
		previousStart, nextStart, newRange,
		fromLeft = 0,
		fromRight = 0,
		nodeOffset = node.getModel().getOffset();

	if ( previous.range && next.range ) {
		offsetDiff = ( previous.range.isCollapsed() && next.range.isCollapsed() ) ?
			next.range.start - previous.range.start : null;
		lengthDiff = next.text.length - previous.text.length;
		previousStart = previous.range.start - nodeOffset - 1;
		nextStart = next.range.start - nodeOffset - 1;
		sameLeadingAndTrailing = offsetDiff !== null && (
			// TODO: rewrite to static method with tests
			(
				lengthDiff > 0 &&
				previous.text.substring( 0, previousStart ) ===
					next.text.substring( 0, previousStart  ) &&
				previous.text.substring( previousStart ) ===
					next.text.substring( nextStart  )
			) ||
			(
				lengthDiff < 0 &&
				previous.text.substring( 0, nextStart ) ===
					next.text.substring( 0, nextStart ) &&
				previous.text.substring( previousStart - lengthDiff + offsetDiff) ===
					next.text.substring( nextStart )
			)
		);

		// Simple insertion
		if ( lengthDiff > 0 && offsetDiff === lengthDiff /* && sameLeadingAndTrailing */) {
			data = next.text.substring(
				previous.range.start - nodeOffset - 1,
				next.range.start - nodeOffset - 1
			).split( '' );
			// Apply insertion annotations
			annotations = this.model.getInsertionAnnotations();
			if ( annotations instanceof ve.AnnotationSet ) {
				ve.dm.Document.addAnnotationsToData( data, this.model.getInsertionAnnotations() );
			}
			this.disableRendering();
			this.model.change(
				ve.dm.Transaction.newFromInsertion(
					this.documentView.model, previous.range.start, data
				),
				next.range
			);
			this.enableRendering();
			return;
		}

		// Simple deletion
		if ( ( offsetDiff === 0 || offsetDiff === lengthDiff ) && sameLeadingAndTrailing ) {
			if ( offsetDiff === 0 ) {
				range = new ve.Range( next.range.start, next.range.start - lengthDiff );
			} else {
				range = new ve.Range( next.range.start, previous.range.start );
			}
			this.disableRendering();
			this.model.change(
				ve.dm.Transaction.newFromRemoval( this.documentView.model, range ),
				next.range
			);
			this.enableRendering();
			return;
		}
	}

	// Complex change

	len = Math.min( previous.text.length, next.text.length );
	// Count same characters from left
	while ( fromLeft < len && previous.text[fromLeft] === next.text[fromLeft] ) {
		++fromLeft;
	}
	// Count same characters from right
	while (
		fromRight < len - fromLeft &&
		previous.text[previous.text.length - 1 - fromRight] ===
		next.text[next.text.length - 1 - fromRight]
	) {
		++fromRight;
	}
	data = next.text.substring( fromLeft, next.text.length - fromRight ).split( '' );
	// Get annotations to the left of new content and apply
	annotations =
		this.model.getDocument().getAnnotationsFromOffset( nodeOffset + 1 + fromLeft );
	if ( annotations.getLength() ) {
		ve.dm.Document.addAnnotationsToData( data, annotations );
	}
	newRange = next.range;
	if ( newRange.isCollapsed() ) {
		newRange = new ve.Range( this.getNearestCorrectOffset( newRange.start, 1 ) );
	}
	if ( data.length > 0 ) {
		this.model.change(
			ve.dm.Transaction.newFromInsertion(
				this.documentView.model, nodeOffset + 1 + fromLeft, data
			),
			newRange
		);
	}
	if ( fromLeft + fromRight < previous.text.length ) {
		this.model.change(
			ve.dm.Transaction.newFromRemoval(
				this.documentView.model,
				new ve.Range(
					data.length + nodeOffset + 1 + fromLeft,
					data.length + nodeOffset + 1 + previous.text.length - fromRight
				)
			),
			newRange
		);
	}
};

/**
 * Responds to 'selectionChange' events emitted in {ve.ce.SurfaceObserver.prototype.poll}.
 *
 * @method
 */
ve.ce.Surface.prototype.onSelectionChange = function ( oldRange, newRange ) {
	this.disableRendering();
	this.model.change( null, newRange );
	this.enableRendering();
};

/**
 * Responds to surface lock events.
 *
 * @method
 */
ve.ce.Surface.prototype.onLock = function () {
	this.surfaceObserver.stop();
};

/**
 * Responds to surface lock events.
 *
 * @method
 */
ve.ce.Surface.prototype.onUnlock = function () {
	this.surfaceObserver.clear( this.model.getSelection() );
	this.surfaceObserver.start();
};

/**
 * Responds to document focus events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.documentOnFocus = function () {
	this.$document.off( '.ve-ce-Surface' );
	this.$document.on( {
		'keydown.ve-ce-Surface': ve.bind( this.onKeyDown, this ),
		'keyup.ve-ce-Surface': ve.bind( this.onKeyUp, this ),
		'keypress.ve-ce-Surface': ve.bind( this.onKeyPress, this ),
		'mousedown.ve-ce-Surface': ve.bind( this.onMouseDown, this ),
		'mouseup.ve-ce-Surface': ve.bind( this.onMouseUp, this ),
		'mousemove.ve-ce-Surface': ve.bind( this.onMouseMove, this ),
		'compositionstart.ve-ce-Surface': ve.bind( this.onCompositionStart, this ),
		'compositionend.ve-ce-Surface': ve.bind( this.onCompositionEnd, this ),
	} );
	this.surfaceObserver.start( true );
};

ve.ce.Surface.prototype.onCompositionStart = function () {
	if ( $.browser.msie === true ) {
		return;
	}
	this.inIme = true;
	this.handleInsertion();
};

ve.ce.Surface.prototype.onCompositionEnd = function () {
	this.inIme = false;
	this.surfaceObserver.start();
};

/**
 * Responds to document blur events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.documentOnBlur = function () {
	this.$document.off( '.ve-ce-Surface' );
	this.surfaceObserver.stop( true );
};

/**
 * Responds to document mouse down events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onMouseDown = function ( e ) {
	// Remember the mouse is down
	this.dragging = true;

	// Old code to figure out if user clicked inside the document or not - leave it here for now
	// $( e.target ).closest( '.ve-ce-documentNode' ).length === 0

	if ( e.which === 1 ) {
		this.surfaceObserver.stop( true );
	}

	// Block / prevent triple click
	if ( this.getClickCount( e.originalEvent ) > 2 ) {
		e.preventDefault();
	}
};

/**
 * Responds to document mouse up events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onMouseUp = function ( e ) {
	this.surfaceObserver.start();
	if ( !e.shiftKey && this.selecting ) {
		this.emit( 'selectionEnd' );
		this.selecting = false;
	}
	this.dragging = false;
};

/**
 * Responds to document mouse move events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onMouseMove = function () {
	// Detect beginning of selection by moving mouse while dragging
	if ( this.dragging && !this.selecting ) {
		this.selecting = true;
		this.emit( 'selectionStart' );
	}
};

/**
 * Responds to document key up events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onKeyUp = function ( e ) {
	// Detect end of selecting by letting go of shift
	if ( !this.dragging && this.selecting && e.keyCode === 16 ) {
		this.selecting = false;
		this.emit( 'selectionEnd' );
	}
};

/**
 * Responds to document key down events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onKeyDown = function ( e ) {
	if ( this.inIme === true ) {
		return;
	}

	if ( e.which === 229 && $.browser.msie === true ) {
		this.inIme = true;
		this.handleInsertion();
		return;
	}

	// Detect start of selecting using shift+arrow keys
	if ( !this.dragging && !this.selecting && e.shiftKey && e.keyCode >= 37 && e.keyCode <= 40 ) {
		this.selecting = true;
		this.emit( 'selectionStart' );
	}

	switch ( e.keyCode ) {
		// Left arrow
		case 37:
			if ( this.adjustCursor( -1 ) ) {
				e.preventDefault();
			}
			break;
		// Right arrow
		case 39:
			if ( this.adjustCursor( 1 ) ) {
				e.preventDefault();
			}
			break;
		// Enter
		case 13:
			e.preventDefault();
			this.handleEnter( e );
			break;
		// Backspace
		case 8:
			this.handleDelete( e, true );
			this.surfaceObserver.stop( true );
			this.surfaceObserver.start();
			break;
		// Delete
		case 46:
			this.handleDelete( e, false );
			this.surfaceObserver.stop( true );
			this.surfaceObserver.start();
			break;
		default:
			// Execute key command if available
			this.surfaceObserver.stop( true );
			if ( this.surface.execute( new ve.Command( e ) ) ) {
				e.preventDefault();
			}
			this.surfaceObserver.start();
	}
};

/**
 * Responds to copy events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onCopy = function () {
	var sel = rangy.getSelection(),
		$frag = $( sel.getRangeAt(0).cloneContents() ),
		slice = this.documentView.model.getSlice( this.model.getSelection() ),
		key = '';

	// Create key from text and element names
	$frag.contents().each( function () {
		key += this.textContent || this.nodeName;
	} );
	key = 've-' + key.replace( /\s/gm, '' );

	// Set clipboard and localStorage
	this.clipboard[key] = slice;
	try {
		localStorage.setItem(
			key,
			JSON.stringify( {
				'time': new Date().getTime(),
				'data': slice
			} )
		);
	} catch ( e ) {
		// Silently ignore
	}
};

/**
 * Responds to cut events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onCut = function ( e ) {
	var surface = this;

	this.surfaceObserver.stop();

	this.onCopy( e );

	setTimeout( function () {
		var selection,
			tx;

		// We don't like how browsers cut, so let's undo it and do it ourselves.
		document.execCommand( 'undo', false, false );

		selection = surface.model.getSelection();

		// Transact
		tx = ve.dm.Transaction.newFromRemoval( surface.documentView.model, selection );
		surface.model.change( tx, new ve.Range( selection.start ) );

		surface.surfaceObserver.clear();
		surface.surfaceObserver.start();
	}, 1 );
};

/**
 * Responds to paste events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onPaste = function ( e ) {
	// Prevent pasting until after we are done
	if ( this.pasting ) {
		e.preventDefault();
		return false;
	}
	this.pasting = true;

	var tx, scrollTop,
		$window = $( window ),
		view = this,
		selection = this.model.getSelection();

	this.surfaceObserver.stop();

	// Pasting into a range? Remove first.
	if ( !rangy.getSelection().isCollapsed ) {
		tx = ve.dm.Transaction.newFromRemoval( view.documentView.model, selection );
		view.model.change( tx );
	}

	// Save scroll position and change focus to "offscreen" paste target
	scrollTop = $window.scrollTop();
	$( '#paste' ).html( '' ).show().focus();

	setTimeout( function () {
		var pasteText, pasteData, tx,
			key = '';

		// Create key from text and element names
		$( '#paste' ).hide().contents().each( function () {
			key += this.textContent || this.nodeName;
		} );
		key = 've-' + key.replace( /\s/gm, '' );

		// Get linear model from clipboard, localStorage, or create array from unknown pasted content
		if ( view.clipboard[key] ) {
			pasteData = view.clipboard[key];
		}
		/*
		else if ( localStorage.getItem( key ) ) {
			pasteData = localStorage.getItem( key ).data;
		}
		*/
		else {
			pasteText = $( '#paste' ).text().replace( /\n/gm, '');
			pasteData = new ve.dm.DocumentSlice( pasteText.split( '' ) );
		}

		// Transact
		try {
			tx = ve.dm.Transaction.newFromInsertion(
				view.documentView.model,
				selection.start,
				pasteData.getData()
			);
		} catch ( e ) {
			tx = ve.dm.Transaction.newFromInsertion(
				view.documentView.model,
				selection.start,
				pasteData.getBalancedData()
			);
		}

		// Restore focus and scroll position
		view.documentView.documentNode.$.focus();
		$window.scrollTop( scrollTop );

		view.model.change( tx, tx.translateRange( selection ).truncate( 0 ) );

		// Allow pasting again
		view.pasting = false;
	}, 0 );
};

/**
 * Responds to document key press events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.onKeyPress = function ( e ) {
	if ( ve.ce.Surface.isShortcutKey( e ) || e.which === 13 || e.which === 8 || e.which === 0 ) {
		return;
	}
	this.handleInsertion();
	setTimeout( ve.bind( function () {
		this.surfaceObserver.start();
	}, this ), 0 );
};

/**
 * Called from ve.dm.Surface.prototype.change.
 *
 * @method
 * @param {ve.dm.Transaction|null} transaction
 * @param {ve.Range|undefined} selection
 */
ve.ce.Surface.prototype.onChange = function ( transaction, selection ) {
	if ( selection && this.isRenderingEnabled() ) {
		this.showSelection( selection );
	}
};

/**
 * Responds to enter key events.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.prototype.handleEnter = function ( e ) {
	var tx, outerParent, outerChildrenCount, list,
		selection = this.model.getSelection(),
		documentModel = this.model.getDocument(),
		emptyParagraph = [{ 'type': 'paragraph' }, { 'type': '/paragraph' }],
		advanceCursor = true,
		node = this.documentView.getNodeFromOffset( selection.from ),
		nodeModel = node.getModel(),
		cursor = selection.from,
		contentBranchModel = nodeModel.isContent() ? nodeModel.getParent() : nodeModel,
		contentBranchModelRange = contentBranchModel.getRange(),
		stack = [],
		outermostNode = null;

	// Stop polling while we work
	this.surfaceObserver.stop();

	// Handle removal first
	if ( selection.from !== selection.to ) {
		tx = ve.dm.Transaction.newFromRemoval( documentModel, selection );
		selection = tx.translateRange( selection );
		this.model.change( tx, selection );
	}

	// Handle insertion
	if (
		contentBranchModel.getType() !== 'paragraph' &&
		(
			cursor === contentBranchModelRange.from ||
			cursor === contentBranchModelRange.to
		)
	) {
		// If we're at the start/end of something that's not a paragraph, insert a paragraph
		// before/after
		if ( cursor === contentBranchModelRange.from ) {
			tx = ve.dm.Transaction.newFromInsertion(
				documentModel, contentBranchModel.getOuterRange().from, emptyParagraph
			);
		} else if ( cursor === contentBranchModelRange.to ) {
			tx = ve.dm.Transaction.newFromInsertion(
				documentModel, contentBranchModel.getOuterRange().to, emptyParagraph
			);
		}
	} else {
		// Split
		ve.Node.traverseUpstream( node, function ( node ) {
			if ( !node.canBeSplit() ) {
				return false;
			}
			stack.splice(
				stack.length / 2,
				0,
				{ 'type': '/' + node.type },
				node.model.getClonedElement()
			);
			outermostNode = node;
			if ( e.shiftKey ) {
				return false;
			} else {
				return true;
			}
		} );

		outerParent = outermostNode.getModel().getParent();
		outerChildrenCount = outerParent.getChildren().length;

		if (
			// This is a list item
			outermostNode.type === 'listItem' &&
			// This is the last list item
			outerParent.getChildren()[outerChildrenCount - 1] === outermostNode.getModel() &&
			// There is one child
			outermostNode.children.length === 1 &&
			// The child is empty
			node.model.length === 0
		) {
			// Enter was pressed in an empty list item.
			list = outermostNode.getModel().getParent();
			// Remove the list item
			tx = ve.dm.Transaction.newFromRemoval(
				documentModel, outermostNode.getModel().getOuterRange()
			);
			this.model.change( tx );
			// Insert a paragraph
			tx = ve.dm.Transaction.newFromInsertion(
				documentModel, list.getOuterRange().to, emptyParagraph
			);
			advanceCursor = false;
		} else {
			// We must process the transaction first because getRelativeContentOffset can't help us
			// yet
			tx = ve.dm.Transaction.newFromInsertion( documentModel, selection.from, stack );
		}
	}

	// Commit the transaction
	this.model.change( tx );

	// Now we can move the cursor forward
	if ( advanceCursor ) {
		this.model.change(
			null, new ve.Range( documentModel.getRelativeContentOffset( selection.from, 1 ) )
		);
	} else {
		this.model.change(
			null, new ve.Range( documentModel.getNearestContentOffset( selection.from ) )
		);
	}
	// Reset and resume polling
	this.surfaceObserver.clear();
	this.surfaceObserver.start();
};

/**
 * Adjusts the cursor position in a given distance.
 *
 * This method only affects the selection target, preserving selections that are not collapsed and
 * the direction of the selection.
 *
 * @method
 * @param {Number} adjustment Distance to adjust the cursor, can be positive or negative
 * @returns {Boolean} Cursor was moved
 */
ve.ce.Surface.prototype.adjustCursor = function ( adjustment ) {
	// Bypass for zero-adjustment
	if ( !adjustment ) {
		return false;
	}
	var adjustedTargetOffset,
		bias = adjustment > 0 ? 1 : -1,
		selection = this.model.getSelection(),
		targetOffset = selection.to,
		documentModel = this.model.getDocument(),
		relativeContentOffset = documentModel.getRelativeContentOffset( targetOffset, adjustment ),
		relativeStructuralOffset = documentModel.getRelativeStructuralOffset(
			targetOffset + bias, adjustment, true
		);
	// Check if we've moved into a slug
	if ( this.hasSlugAtOffset( relativeStructuralOffset ) ) {
		// Check if the relative content offset is in the opposite direction we are trying to go
		if ( ( relativeContentOffset - targetOffset < 0 ? -1 : 1 ) !== bias ) {
			// There's nothing past the slug we are already in, stay in it
			adjustedTargetOffset = relativeStructuralOffset;
		} else {
			// There's a slug neaby, go into it if it's closer
			adjustedTargetOffset = adjustment < 0 ?
				Math.max( relativeContentOffset, relativeStructuralOffset ) :
				Math.min( relativeContentOffset, relativeStructuralOffset );
		}
	}
	// Check if we've moved a different distance than we asked for
	else if ( relativeContentOffset !== targetOffset + adjustment ) {
		// We can't trust the browser, move programatically
		adjustedTargetOffset = relativeContentOffset;
	}
	// If the target changed, update the model
	if ( adjustedTargetOffset ) {
		this.model.change(
			null,
			new ve.Range(
				selection.isCollapsed() ?
					adjustedTargetOffset : selection.from, adjustedTargetOffset
			)
		);
		return true;
	}
	return false;
};

/**
 * Responds to backspace and delete key events.
 *
 * @method
 * @param {Boolean} Key was a backspace
 */
ve.ce.Surface.prototype.handleDelete = function ( e, backspace ) {
	var sourceOffset,
		targetOffset,
		sourceSplitableNode,
		targetSplitableNode,
		tx,
		cursorAt,
		sourceNode,
		targetNode,
		sourceData,
		nodeToDelete,
		adjacentData,
		adjacentText,
		adjacentTextAfterMatch,
		endOffset,
		i,
		selection = this.model.getSelection(),
		containsInlineElements = false;

	if ( selection.from === selection.to ) {
		// Set source and target linmod offsets
		if ( backspace ) {
			sourceOffset = selection.to;
			targetOffset = this.getNearestCorrectOffset( sourceOffset - 1, -1 );

			// At the beginning of the document - don't do anything and preventDefault
			if ( sourceOffset === targetOffset ) {
				e.preventDefault();
				return;
			}

		} else {
			sourceOffset = this.model.getDocument().getRelativeContentOffset( selection.to, 1 );
			targetOffset = selection.to;

			// At the end of the document - don't do anything and preventDefault
			if ( sourceOffset <= targetOffset ) {
				e.preventDefault();
				return;
			}
		}

		// Set source and target nodes
		sourceNode = this.documentView.getNodeFromOffset( sourceOffset, false ),
		targetNode = this.documentView.getNodeFromOffset( targetOffset, false );

		if ( sourceNode.type === targetNode.type ) {
			sourceSplitableNode = ve.ce.Node.getSplitableNode( sourceNode );
			targetSplitableNode = ve.ce.Node.getSplitableNode( targetNode );
		}
		//ve.log(sourceSplitableNode, targetSplitableNode);

		// Save target location of cursor
		cursorAt = targetOffset;

		// Get text from cursor location to end of node in the proper direction
		adjacentData = null;
		adjacentText = '';

		if ( backspace ) {
			adjacentData = sourceNode.model.doc.data.slice(
				sourceNode.model.getOffset() + ( sourceNode.model.isWrapped() ? 1 : 0 ) ,
				sourceOffset
			);
		} else {
			endOffset = targetNode.model.getOffset() +
				targetNode.model.getLength() +
				( targetNode.model.isWrapped() ? 1 : 0 );
			adjacentData = targetNode.model.doc.data.slice( targetOffset, endOffset );
		}

		for ( i = 0; i < adjacentData.length; i++ ) {
			if ( adjacentData[i].type !== undefined ) {
				containsInlineElements = true;
				break;
			}
			adjacentText += adjacentData[i][0];
		}

		if ( !containsInlineElements ) {
			adjacentTextAfterMatch = adjacentText.match(
				/[a-zA-Z\-_’'‘ÆÐƎƏƐƔĲŊŒẞÞǷȜæðǝəɛɣĳŋœĸſßþƿȝĄƁÇĐƊĘĦĮƘŁØƠŞȘŢȚŦŲƯY̨Ƴąɓçđɗęħįƙłøơşșţțŧųưy̨ƴÁÀÂÄǍĂĀÃÅǺĄÆǼǢƁĆĊĈČÇĎḌĐƊÐÉÈĖÊËĚĔĒĘẸƎƏƐĠĜǦĞĢƔáàâäǎăāãåǻąæǽǣɓćċĉčçďḍđɗðéèėêëěĕēęẹǝəɛġĝǧğģɣĤḤĦIÍÌİÎÏǏĬĪĨĮỊĲĴĶƘĹĻŁĽĿʼNŃN̈ŇÑŅŊÓÒÔÖǑŎŌÕŐỌØǾƠŒĥḥħıíìiîïǐĭīĩįịĳĵķƙĸĺļłľŀŉńn̈ňñņŋóòôöǒŏōõőọøǿơœŔŘŖŚŜŠŞȘṢẞŤŢṬŦÞÚÙÛÜǓŬŪŨŰŮŲỤƯẂẀŴẄǷÝỲŶŸȲỸƳŹŻŽẒŕřŗſśŝšşșṣßťţṭŧþúùûüǔŭūũűůųụưẃẁŵẅƿýỳŷÿȳỹƴźżžẓ]/g
			);
			// If there are "normal" characters in the adjacent text, let the browser handle natively.
			if ( adjacentTextAfterMatch !== null && adjacentTextAfterMatch.length ) {
				return;
			}
		}

		ve.log('handleDelete programatically');
		e.preventDefault();
		this.surfaceObserver.stop();

		if (
			// Source and target are the same node
			sourceNode === targetNode ||
			(
				// Source and target have the same parent (list items)
				sourceSplitableNode !== undefined &&
				sourceSplitableNode.getParent() === targetSplitableNode.getParent()
			)
		) {
			// Simple removal
			tx = ve.dm.Transaction.newFromRemoval(
				this.documentView.model, new ve.Range( targetOffset, sourceOffset )
			);
			this.model.change( tx, new ve.Range( cursorAt ) );
		} else if ( sourceNode.getType() === 'document' ) {
			// Source is a slug - move the cursor somewhere useful
			this.model.change( null, new ve.Range( cursorAt ) );
		} else {
			// Source and target are different nodes or do not share a parent, perform tricky merge
			// Get the data for the source node
			sourceData = this.documentView.model.getData( sourceNode.model.getRange() );

			// Find the node that should be completely removed
			nodeToDelete = sourceNode;
			ve.Node.traverseUpstream( nodeToDelete, function ( node ) {
				if ( node.getParent().children.length === 1 ) {
					nodeToDelete = node.getParent();
					return true;
				} else {
					return false;
				}
			} );

			this.model.change(
				[
					// Remove source node or source node ancestor
					ve.dm.Transaction.newFromRemoval(
						this.documentView.model, nodeToDelete.getModel().getOuterRange()
					),
					// Append source data to target
					ve.dm.Transaction.newFromInsertion(
						this.documentView.model, targetOffset, sourceData
					)
				],
				new ve.Range( cursorAt )
			);
		}
	} else {
		// Selection removal
		ve.log('selection removal - handle programatically');
		e.preventDefault();
		this.model.change(
			ve.dm.Transaction.newFromRemoval( this.documentView.model, selection ),
			new ve.Range( selection.start )
		);
	}

	this.surfaceObserver.clear();
	this.surfaceObserver.start();
};

/**
 * Shows the cursor at a given offset.
 *
 * @method
 * @param {Number} offset Offset to show cursor at
 */
ve.ce.Surface.prototype.showCursor = function ( offset ) {
	this.showSelection( new ve.Range( offset ) );
};

/**
 * Shows selection on a given range.
 *
 * @method
 * @param {ve.Range} range Range to show selection on
 */
ve.ce.Surface.prototype.showSelection = function ( range ) {
	var start, end,
		rangySel = rangy.getSelection(),
		rangyRange = rangy.createRange();

	// Ensure the range we are asking to select is from and to correct offsets - failure to do so
	// may cause getNodeAndOffset to throw an exception
	range = new ve.Range(
		this.getNearestCorrectOffset( range.start ),
		this.getNearestCorrectOffset( range.end )
	);

	if ( range.start !== range.end ) {
		start = this.getNodeAndOffset( range.start );
		end = this.getNodeAndOffset( range.end );

		if ( false && $.browser.msie ) {
			if ( range.start === range.from ) {
				if (
					start.node === this.poll.rangySelection.anchorNode &&
					start.offset === this.poll.rangySelection.anchorOffset &&
					end.node === this.poll.rangySelection.focusNode &&
					end.offset === this.poll.rangySelection.focusOffset
				) {
					return;
				}
			} else {
				if (
					end.node === this.poll.rangySelection.anchorNode &&
					end.offset === this.poll.rangySelection.anchorOffset &&
					start.node === this.poll.rangySelection.focusNode &&
					start.offset === this.poll.rangySelection.focusOffset
				) {
					return;
				}
			}
		}

		rangyRange.setStart( start.node, start.offset );
		rangyRange.setEnd( end.node, end.offset );
		rangySel.removeAllRanges();
		rangySel.addRange( rangyRange, range.start !== range.from );
	} else {
		start = end = this.getNodeAndOffset( range.start );

		if ( false && $.browser.msie ) {
			if (
				start.node === this.poll.rangySelection.anchorNode &&
				start.offset === this.poll.rangySelection.anchorOffset
			) {
				return;
			}
		}

		rangyRange.setStart( start.node, start.offset );
		rangySel.setSingleRange( rangyRange );
	}
};

/**
 * Gets the nearest offset that a cursor can actually be placed at.
 *
 * TODO: Find a better name and a better place for this method
 *
 * @method
 * @param {Number} offset Offset to start looking at
 * @param {Number} [direction=-1] Direction to look in, +1 or -1
 */
ve.ce.Surface.prototype.getNearestCorrectOffset = function ( offset, direction ) {
	var contentOffset, structuralOffset;

	direction = direction > 0 ? 1 : -1;
	if (
		ve.dm.Document.isContentOffset( this.documentView.model.data, offset ) ||
		this.hasSlugAtOffset( offset )
	) {
		return offset;
	}

	contentOffset = this.documentView.model.getNearestContentOffset( offset, direction );
	structuralOffset = this.documentView.model.getNearestStructuralOffset( offset, direction, true );

	if ( !this.hasSlugAtOffset( structuralOffset ) ) {
		return contentOffset;
	}

	if ( direction === 1 ) {
		if ( contentOffset < offset ) {
			return structuralOffset;
		} else {
			return Math.min( contentOffset, structuralOffset );
		}
	} else {
		if ( contentOffset > offset ) {
			return structuralOffset;
		} else {
			return Math.max( contentOffset, structuralOffset );
		}
	}
};

/**
 * Checks if a given offset is inside a slug.
 *
 * TODO: Find a better name and a better place for this method - probably in a document view?
 *
 * @method
 * @param {Number} offset Offset to check for a slug at
 * @returns {Boolean} A slug exists at the given offset
 */
ve.ce.Surface.prototype.hasSlugAtOffset = function ( offset ) {
	return !!this.documentView.getSlugAtOffset( offset );
};

/**
 * Gets a DOM node and offset that can be used to place a cursor, based on a given offset.
 *
 * The results of this function are meant to be used with rangy.
 *
 * @method
 * @param {Number} offset Linear model offset
 * @returns {Object} Object containing a node and offset property where node is an HTML element and
 * offset is the position within the element
 * @throws {Error} Offset could not be translated to a DOM element and offset
 */
ve.ce.Surface.prototype.getNodeAndOffset = function ( offset ) {
	var node, startOffset, current, stack, item, $item, length,
		slug = this.documentView.getSlugAtOffset( offset );
	if ( slug ) {
		return { node: slug[0].childNodes[0], offset: 0 };
	}
	node = this.documentView.getNodeFromOffset( offset );
	startOffset = this.documentView.getDocumentNode().getOffsetFromNode( node ) +
		( ( node.isWrapped() ) ? 1 : 0 );
	current = [node.$.contents(), 0];
	stack = [current];

	while ( stack.length > 0 ) {
		if ( current[1] >= current[0].length ) {
			stack.pop();
			current = stack[ stack.length - 1 ];
			continue;
		}
		item = current[0][current[1]];
		if ( item.nodeType === Node.TEXT_NODE ) {
			length = item.textContent.length;
			if ( offset >= startOffset && offset <= startOffset + length ) {
				return {
					node: item,
					offset: offset - startOffset
				};
			} else {
				startOffset += length;
			}
		} else if ( item.nodeType === Node.ELEMENT_NODE ) {
			$item = current[0].eq( current[1] );
			if ( $item.hasClass('ve-ce-slug') ) {
				if ( offset === startOffset ) {
					return {
						node: $item[0],
						offset: 1
					};
				}
			} else if ( $item.is( '.ve-ce-branchNode, .ve-ce-leafNode' ) ) {
				length = $item.data( 'node' ).model.getOuterLength();
				if ( offset >= startOffset && offset < startOffset + length ) {
					stack.push( [$item.contents(), 0] );
					current[1]++;
					current = stack[stack.length-1];
					continue;
				} else {
					startOffset += length;
				}
			} else {
				stack.push( [$item.contents(), 0] );
				current[1]++;
				current = stack[stack.length-1];
				continue;
			}
		}
		current[1]++;
	}
	throw new Error( 'Offset could not be translated to a DOM element and offset: ' + offset );
};

/**
 * Gets the coordinates of the selection anchor.
 *
 * @method
 */
ve.ce.Surface.prototype.getSelectionRect = function () {
	var rangySel = rangy.getSelection();
	return {
		start: rangySel.getStartDocumentPos(),
		end: rangySel.getEndDocumentPos()
	};
};

/**
 * Tests if the modifier key for keyboard shortcuts is pressed.
 *
 * @method
 * @param {jQuery.Event} e
 */
ve.ce.Surface.isShortcutKey = function ( e ) {
	if ( e.ctrlKey || e.metaKey ) {
		return true;
	}
	return false;
};

/**
 * Removes localStorage keys for copy and paste after a day.
 *
 * @method
 */
ve.ce.Surface.clearLocalStorage = function () {
	var i, len, key, time, now,
		keysToRemove = [];

	for ( i = 0, len = localStorage.length; i < len; i++ ) {
		key = localStorage.key( i );

		if ( key.indexOf( 've-' ) !== 0 ) {
			return false;
		}

		time = JSON.parse( localStorage.getItem( key ) ).time;
		now = new Date().getTime();

		// Offset: 24 days (in miliseconds)
		if ( now - time > ( 24 * 3600 * 1000 ) ) {
			// Don't remove keys while iterating. Store them for later removal.
			keysToRemove.push( key );
		}
	}

	$.each( keysToRemove, function ( i, val ) {
		localStorage.removeItem( val );
	} );
};

/**
 * Gets the surface model.
 *
 * @method
 * @returns {ve.dm.Surface} Surface model
 */
ve.ce.Surface.prototype.getModel = function () {
	return this.model;
};

/**
 * Gets the document view.
 *
 * @method
 * @returns {ve.ce.Document} Document view
 */
ve.ce.Surface.prototype.getDocument = function () {
	return this.documentView;
};

/**
 * @method
 */
ve.ce.Surface.prototype.enableRendering = function () {
	this.renderingEnabled = true;
};

/**
 * @method
 */
ve.ce.Surface.prototype.disableRendering = function () {
	this.renderingEnabled = false;
};

/**
 * @method
 */
ve.ce.Surface.prototype.isRenderingEnabled = function () {
	return this.renderingEnabled;
};

/**
 * Determines the number of clicks in a user action
 *
 * @method
 * @param {MouseEvent} e Original event (not jQuery)
 * @returns {int} Number of clicks detected
 */
ve.ce.Surface.prototype.getClickCount = function ( e ) {
	if ( !$.browser.msie ) {
		return e.detail;
	}

	var i, response = 1;

	// Add select MouseEvent properties to the beginning of the clickHistory
	this.clickHistory.unshift({
		x: e.x,
		y: e.y,
		timeStamp: e.timeStamp
	});

	// Compare history
	if ( this.clickHistory.length > 1 ) {
		for ( i = 0; i < this.clickHistory.length - 1; i++ ) {
			if (
				this.clickHistory[i].x === this.clickHistory[i + 1].x &&
				this.clickHistory[i].y === this.clickHistory[i + 1].y &&
				this.clickHistory[i].timeStamp - this.clickHistory[i + 1].timeStamp < 500
			) {
				response++;
			} else {
				break;
			}
		}
	}

	// Trim old history if necessary
	if ( this.clickHistory.length > 2 ) {
		this.clickHistory.pop();
	}

	return response;
};