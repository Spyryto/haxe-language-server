package haxeLanguageServer.documents;

import haxeLanguageServer.helper.PathHelper;
import js.node.Fs;

@:allow(haxeLanguageServer.Context)
class TextDocuments {
	public static inline final syncKind = TextDocumentSyncKind.Incremental;

	final documents = new Map<DocumentUri, HxTextDocument>();

	public function new() {}

	public inline function iterator():Iterator<HxTextDocument> {
		return documents.iterator();
	}

	/**
		Resolve compiler paths to the URI originally opened by the editor.
		On macOS, for example, Haxe can return /private/var/... while the
		client opened file:///var/... (a symlink to the same directory).
		Publishing compiler-generated URIs would create phantom diagnostics,
		and loading their source from disk would ignore unsaved edits.
	**/
	public function resolveOpenUri(uri:DocumentUri):DocumentUri {
		if (documents.exists(uri) || !uri.isFile())
			return uri;

		final path = try {
			PathHelper.normalize(new FsPath(cast Fs.realpathSync(uri.toFsPath()))).toString();
		} catch (_:Dynamic) {
			return uri;
		}

		for (openUri in documents.keys()) {
			if (!openUri.isFile())
				continue;
			final openPath = try {
				PathHelper.normalize(new FsPath(cast Fs.realpathSync(openUri.toFsPath()))).toString();
			} catch (_:Dynamic) {
				continue;
			}
			if (path == openPath)
				return openUri;
		}
		return uri;
	}

	public inline function getHaxe(uri:DocumentUri):Null<HaxeDocument> {
		var doc:Null<HaxeDocument> = Std.downcast(documents[uri], HaxeDocument);
		if (doc == null && uri.isHaxeFile()) {
			// document not opened via client, load it directly from disk
			// see https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_didOpen
			doc = new HaxeDocument(uri, "hx", 1, sys.io.File.getContent(uri.toFsPath().toString()));
		}
		return doc;
	}

	public inline function getHxml(uri:DocumentUri):Null<HxmlDocument> {
		var doc:Null<HxmlDocument> = Std.downcast(documents[uri], HxmlDocument);
		if (doc == null && uri.isHxmlFile()) {
			// document not (yet) loaded via client, load it directly from disk
			// see https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_didOpen
			doc = new HxmlDocument(uri, "hxml", 1, sys.io.File.getContent(uri.toFsPath().toString()));
		}
		return doc;
	}

	function onDidOpenTextDocument(event:DidOpenTextDocumentParams) {
		final td = event.textDocument;
		final uri = td.uri;
		if (uri.isHaxeFile()) {
			documents[td.uri] = new HaxeDocument(td.uri, td.languageId, td.version, td.text);
		} else if (uri.isHxmlFile()) {
			documents[td.uri] = new HxmlDocument(td.uri, td.languageId, td.version, td.text);
		} else {
			throw uri + " has unsupported file type (must be .hx or .hxml)";
		}
	}

	function onDidChangeTextDocument(event:DidChangeTextDocumentParams) {
		final td = event.textDocument;
		final changes = event.contentChanges;
		if (changes.length == 0)
			return;
		final document = documents[td.uri];
		if (document != null) {
			document.update(changes, td.version);
		}
	}

	function onDidCloseTextDocument(event:DidCloseTextDocumentParams) {
		documents.remove(event.textDocument.uri);
	}
}
