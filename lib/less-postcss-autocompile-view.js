'use babel';

/*eslint-env node*/
/*eslint vars-on-top: 0*/

import async from 'async';
import fs from 'fs';
import less from 'less';
import mkdirp from 'mkdirp';
import path from 'path';
import readline from 'readline';
import postcss from 'postcss';
import postcssPlugins from './postcss-plugins.js';

var inProgress = false;

export default class AutocompileView {

	constructor(serializeState) {
		atom.commands.add('atom-workspace', {
			'core:save': () => {
				this.handleSave();
			}
		});
	}

	serialize() {}

	destroy() {}

	handleSave() {
		this.activeEditor = atom.workspace.getActiveTextEditor();


		if (this.activeEditor) {
			this.filePath = this.activeEditor.getURI();
			this.fileExt = path.extname(this.filePath);

			if (this.fileExt === '.less') {
				if (inProgress) {
					atom.notifications.addWarning('File not compiled', {
						detail: 'Previous save operation in progress.'
					});
				} else {
					this.getParams(this.filePath, (params) => {
						this.compileLess(params);
					});
				}
			}
		}
	}

	writeFiles(output, newPath, newFile) {

		async.series({
			css: (callback) => {
				if (output.css) {
					this.writeFile(output.css, newPath, newFile, function() {
						callback(null, newFile);
					});
				} else {
					callback(null, null);
				}
			},
			map: (callback) => {

				let newFileMap = `${newFile}.map`;

				if (output.map) {

					this.writeFile(output.map, newPath, newFileMap, function() {
						callback(null, newFileMap);
					});
				} else {
					callback(null, null);
				}
			},
			oldie: (callback) => {
				if (output.oldie) {
					let newFileOldie = newFile.replace('.css', '.oldie.css');

					this.writeFile(output.oldie, newPath, newFileOldie, function() {
						callback(null, newFileOldie);
					});
				} else {
					callback(null, null);
				}
			}
		}, function(err, results) {
			inProgress = false;

			if (err) {
				return atom.notifications.addError(err, {
					dismissable: true
				});
			} else {
				if (results.map !== null) {
					atom.notifications.addSuccess('Files created', {
						detail: `${results.css}\n${results.map}`
					});
				} else {
					atom.notifications.addSuccess('File created', {
						detail: results.css
					});
				}
			}
		});
	}

	compileLess(params) {

		if (!params.out) {
			return;
		}

		inProgress = true;

		var firstLine = true;
		var contentFile = [];
		var optionsLess = {
			paths: [path.dirname(path.resolve(params.file))],
			filename: path.basename(params.file),
			sourceMap: params.sourcemap === 'true' ? ({}) : false
		};

		var optionsPostcss = {};

		postcssPlugins(params, optionsPostcss);

		var rl = readline.createInterface({
			input: fs.createReadStream(params.file),
			terminal: false
		});

		rl.on('line', function(line) {
			if (!firstLine) {
				contentFile.push(line);
			} else {
				firstLine = false;
			}
			return firstLine;
		});

		rl.on('close', () => {
			this.renderLess(params, contentFile, optionsLess, optionsPostcss);
		});

	}

	renderLess(params, contentFile, optionsLess, optionsPostcss) {

		var contentFileJoined = contentFile.join('\n');

		less.render(contentFileJoined, optionsLess).then((output) => {

			var newFile = path.resolve(path.dirname(params.file), params.out);
			var newPath = path.dirname(newFile);

			this.processPostcss(output, newPath, newFile, optionsPostcss);

		}, function(err) {

			inProgress = false;

			if (err) {
				atom.notifications.addError(err.message, {
					detail: `${err.filename}:${err.line}`,
					dismissable: true
				});
			}

		});

	}

	processPostcss(lessOutput, newPath, newFile, optionsPostcss) {

		var oldieIndex = optionsPostcss.plugins.findIndex((plugin) => plugin.postcssPlugin === 'oldie');
		var oldie = (oldieIndex > -1) ? optionsPostcss.plugins.splice(oldieIndex, 1) : null;
		var mapOpts = (!lessOutput.map) ? false : { prev: lessOutput.map, annotation: true };

		postcss(optionsPostcss.plugins).process(lessOutput.css, {
			from: this.filePath,
			to: newFile,
			map: mapOpts
		})
		.then((result) => {

			var resultBeforeOldie = result;

			if (!oldie) {
				this.writeFiles(result, newPath, newFile);
			} else {
				postcss(oldie).process(resultBeforeOldie.css, {
					from: this.filePath,
					to: newFile,
					map: false
				})
				.then((result) => {
					resultBeforeOldie.oldie = result.css;
					this.writeFiles(resultBeforeOldie, newPath, newFile);
				});
			}
		});


	}

	writeFile(contentFile, newPath, newFile, callback) {
		return mkdirp(newPath, function(err) {
			if (err) {
				inProgress = false;
				atom.notifications.addError(err, {
					dismissable: true
				});
			} else {
				fs.writeFile(newFile, contentFile, callback);
			}
		});
	}

	getParams(filePath, callback) {

		if (!fs.existsSync(filePath)) {
			inProgress = false;
			atom.notifications.addError(`${filePath} not exist`, {
				dismissable: true
			});

			return;
		}

		this.params = {
			file: filePath
		};

		this.firstLine = true;

		var rl = readline.createInterface({
			input: fs.createReadStream(filePath),
			terminal: false
		});

		rl.on('line', (line) => {
			this.parseFirstLine(line);
		});

		rl.on('close', () => {
			if (this.params.main) {
				this.compileMainFiles(filePath, this.params.main, callback);
			} else {
				callback(this.params);
			}
		});
	}

	// Iterate through each main file and compile them.
	// Wait until the last file is processed before continuing.
	compileMainFiles(filePath, items, callback, currentIndex) {

		var i = 0;
		var that = this;

		function waitBeforeIteration() {
			setTimeout(function() {
				that.compileMainFiles(filePath, items, callback, i);
			}, 100);
		}

		if (currentIndex !== undefined) {
			i = currentIndex;
		}

		for (; i < items.length; i++) {
			if (inProgress) {
				waitBeforeIteration();
				break;
			}
			inProgress = true;
			this.getParams(path.resolve(path.dirname(filePath), items[i]), callback);
		}


	}

	parseFirstLine(line) {

		if (!this.firstLine) {
			return;
		}

		this.firstLine = false;

		line.split(',').forEach((item) => {
			var i = item.indexOf(':');

			if (i < 0) {
				return;
			}

			var key = item.substr(0, i).trim();
			var match = /^\s*\/\/\s*(.+)/.exec(key);

			if (match) {
				key = match[1];
			}

			this.params[key] = item.substr(i + 1).trim();

		});

		if (this.params.main) {
			var mains = this.params.main;
			this.params.main = [];

			mains.split('|').forEach((item) => {
				this.params.main.push(item);
			});
		}

	}
}
