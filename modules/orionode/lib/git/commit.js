/*******************************************************************************
 * Copyright (c) 2012 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials are made 
 * available under the terms of the Eclipse Public License v1.0 
 * (http://www.eclipse.org/legal/epl-v10.html), and the Eclipse Distribution 
 * License v1.0 (http://www.eclipse.org/org/documents/edl-v10.html). 
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/
/*eslint-env node */
var api = require('../api'), writeError = api.writeError;
var diff = require("./diff");
var git = require('nodegit');
var url = require('url');
var crypto = require('crypto');

function commitJSON(commit, fileDir, diffs, parents) {
	return {
		"AuthorEmail": commit.author().email(), 
		"AuthorName": commit.author().name(),
		"AuthorImage": "https://www.gravatar.com/avatar/" + crypto.createHash('md5').update(commit.author().email().toLowerCase()).digest("hex") + "?d=mm",
		"Children":[],
		"CommitterEmail": commit.committer().email(),
		"CommitterName": commit.committer().name(),
		"ContentLocation": "/gitapi/commit/" + commit.sha() + fileDir + "?parts=body",
		"DiffLocation": "/gitapi/diff/" + commit.sha() + fileDir,
		"Location": "/gitapi/commit/" + commit.sha() + fileDir,
		"CloneLocation": "/gitapi/clone" + fileDir,
		"Diffs": diffs,
		"Parents": parents,
		"Message": commit.message(),
		"Name": commit.sha(),
		"Time": commit.timeMs(),
		"Type": "Commit"
	};
}

function getCommit(workspaceDir, fileRoot, req, res, next, rest) {
	var query = url.parse(req.url, true).query;
	if (query.parts === "body") {
		getCommitBody(workspaceDir, fileRoot, req, res, next, rest, query);
	} else {
		getCommitLog(workspaceDir, fileRoot, req, res, next, rest, query);
	}
}

function getCommitLog(workspaceDir, fileRoot, req, res, next, rest, query) {
	var segments = rest.split("/");
	var scope = segments[1].replace(/%252F/g, '/');
	var repoPath = segments[3];
	var fileDir = api.join(fileRoot, repoPath);
	repoPath = api.join(workspaceDir, repoPath);

	var page = Number(query.page) || 1;
	var pageSize = Number(query.pageSize) || Number.MAX_SAFE_INTEGER;
	var mergeBase = "true" === query.mergeBase;

	var commits = [];
	function writeResponse(over) {
		var referenceName = scope;
		var resp = {
			"Children": commits,
			"RepositoryPath": "",
			"toRef": {
				"CloneLocation": "/gitapi/clone" + fileDir,
				"CommitLocation": "/gitapi/commit/" + referenceName + fileDir,
				"Current": true,
				"HeadLocation": "/gitapi/commit/HEAD" + fileDir,
				"Location": "/gitapi/branch/" + referenceName + fileDir,
				"Name": referenceName,
				"Type": "Branch"
			}
		};
	
		if (page && !over) {
			var nextLocation = url.parse(req.url, true);
			nextLocation.query.page = page + 1 + "";
			nextLocation.search = null; //So that query object will be used for format
			nextLocation = url.format(nextLocation);
			resp['NextLocation'] = nextLocation;
		}

		if (page && page > 1) {
			var prevLocation = url.parse(req.url, true);
			prevLocation.query.page = page - 1 + "";
			prevLocation.search = null;
			prevLocation = url.format(prevLocation);
			resp['PreviousLocation'] = prevLocation;
		}

		resp = JSON.stringify(resp);
		
		res.statusCode = 200;
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	}

	function log(repo, ref) {
		var revWalk = repo.createRevWalk();
		revWalk.sorting(git.Revwalk.SORT.TOPOLOGICAL);
		
		if (ref.indexOf("..") !== -1) {
			revWalk.pushRange(ref);
		} else {
			try {
				revWalk.push(ref);
			} catch (ex) {
				revWalk.pushRef(ref);
			}
		}

		var count = 0;
		function walk() {
			return revWalk.next()
			.then(function(oid) {
				if (!oid) {
					writeResponse(true);
					return;
				}

				return repo.getCommit(oid)
				.then(function(commit) {
					return Promise.all([commit, getDiff(repo, commit, fileDir), getCommitParents(repo, commit, fileDir)]);
				})
				.then(function(commitAndDiffs) {
					var commit = commitAndDiffs[0];
					var diffs = commitAndDiffs[1];
					var parents = commitAndDiffs[2];
					if (!page || count++ >= (page-1)*pageSize) {
						commits.push(commitJSON(commit, fileDir, diffs, parents));
					}

					if (pageSize && commits.length === pageSize) {
						writeResponse();
						return;
					}

					walk();
				});
			})
			.catch(function(error) {
			if (error.errno === git.Error.CODE.ITEROVER) {
				writeResponse(true);
			} else {
				writeError(404, res, error.message);
			}
			});
		}

		walk();
	}
	git.Repository.open(repoPath)
	.then(function(repo) {
		if (mergeBase) {
			var names = scope.split("..");
			var commit0;
			repo.getReferenceCommit(names[0])
			.then(function(commit) {
				return commit;
			}).catch(function() {
				return repo.getCommit(names[0]);
			}).then(function(commit) {
				commit0 = commit;
				return repo.getReferenceCommit(names[1]);
			}).catch(function() {
				return repo.getCommit(names[1]);
			})
			.then(function(commit1) {
				git.Merge.base(repo, commit0, commit1).then(function(oid) {
					if (oid) {
						log(repo, oid.tostrS());
					} else {
						writeResponse(true);
					}
				});
			}).catch(function(err) {
				writeError(400, res, err.message);
			});
		} else {
			log(repo, scope);
		}
	}).catch(function(err) {
		writeError(400, res, err.message);
	});
}

function getCommitParents(repo, commit, fileDir) {
	return commit.getParents()
	.then(function(parents) {
		return parents.map(function(parent) {
			return {
				"Location": "/gitapi/commit/" + parent.sha() + fileDir,
				"Name": parent.sha()
			};
		});
	});
}

function getDiff(repo, commit, fileDir) {
	var tree1;
	var tree2;
	var _parent;

	return commit.getTree()
	.then(function(tree) {
		tree2 = tree;
	})
	.then(function() {
		return commit.getParents(1);
	})
	.then(function(parents) {
		return parents && parents[0] ? (_parent = parents[0]).getTree() : null;
	})
	.then(function(tree) {
		tree1 = tree;
	})
	.then(function() {
		return git.Diff.treeToTree(repo, tree1, tree2, null);
	})
	.then(function(diff) {
		return diff.patches();
	})
	.then(function(patches) {
		var range = "";
		if (_parent) range = _parent.id().toString() + "..";
		range += commit.id().toString();
		var page = 1, pageSize = 100;
		var diffs = patches.slice(0, pageSize).map(function(patch) {
			var newFile = patch.newFile();
			var newFilePath = newFile.path();
			var oldFile = patch.oldFile();
			var oldFilePath = oldFile.path();
			var type = diff.changeType(patch);
			var path1 = type !== "Deleted" ? newFilePath : oldFilePath;
			return {
				"ChangeType": type,
				"ContentLocation": fileDir + "/" + path1,
				"DiffLocation": "/gitapi/diff/" + range + fileDir + "/" + path1,
				"NewPath": newFilePath,
				"OldPath": oldFilePath,
				"Type": "Diff"
			};
		});
		var result = {
			"Type": "Diff",
			"Length": patches.length,
			"Children": diffs
		};
		if (patches.length > 100) {
			result.NextLocation = "/gitapi/diff/" + range + fileDir + "?pageSize=" + pageSize + "&page=" + (page + 1);
		}
		return result;
	});
}

function getCommitBody(workspaceDir, fileRoot, req, res, next, rest) {
	var segments = rest.split("/");
	var scope = segments[1];
	var repoPath = segments[3];
	repoPath = api.join(workspaceDir, repoPath);
	var filePath = segments.slice(4).join("/");
	var theRepo;
	git.Repository.open(repoPath)
	.then(function(repo) {
		theRepo = repo;
		return repo.getReferenceCommit(scope);
	})
	.catch(function() {
		return theRepo.getCommit(scope);
	})
	.then(function(commit) {
		return commit.getEntry(filePath);
	})
	.then(function(treeEntry) {
		return treeEntry.getBlob();
	})
	.then(function(blob) {
		var resp = blob.toString();
		res.statusCode = 200;
		res.setHeader('Content-Type', 'application/octect-stream');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	}).catch(function() {
		res.statusCode = 404;
		res.end();
	});
}

function identifyNewCommitResource(req, res, next, rest, commit, newCommit, segments) {
	segments[1] = (commit + ".." + newCommit).replace(/\//g, "%252F");
	var location = "/gitapi/" + segments.join("/");
	location = url.format({pathname: location, query: url.parse(req.url, true).query});
	res.statusCode = 200;
	var resp = JSON.stringify({
		"Location": location
	});
	res.setHeader('Content-Type', 'application/json');
	res.setHeader('Content-Length', resp.length);
	res.end(resp);
}

function revert(req, res, next, rest, repoPath, commitToRevert) {
	var theRepo, theCommit, theRC;
	git.Repository.open(repoPath)
	.then(function(repo) {
		theRepo = repo;
		return git.Commit.lookup(repo, commitToRevert);
	})
	.then(function(commit) {
		theCommit = commit;
		return git.Revert(theRepo, commit, new git.RevertOptions());
	})
	.then(function(rc) {
		theRC = rc;
		if (rc) return;
		var msg = 'Revert "' + theCommit.summary() + '"\n\nThis reverts commit ' + theCommit.sha() + '\n';
		return createCommit(theRepo, null, null, theCommit.author().name(), theCommit.author().email(), msg);
		//TODO: Update Reflog to Revert
	})
	.then(function() {
		return theRepo.stateCleanup();
	})
	.then(function() {
		res.statusCode = 200;
		var resp = JSON.stringify({
			"Result": theRC ? "FAILURE" : "OK"
		});
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	})
	.catch(function(err) {
		writeError(404, res, err.message);
	});
}

function cherryPick(req, res, next, rest, repoPath, commitToCherrypick) {
	var theRepo, theCommit, theRC, theHead;
	git.Repository.open(repoPath)
	.then(function(repo) {
		theRepo = repo;
		return git.Reference.nameToId(theRepo, "HEAD");
	})
	.then(function(head) {
		theHead = head;
		return git.Commit.lookup(theRepo, commitToCherrypick);
	})
	.then(function(commit) {
		theCommit = commit;
		return git.Cherrypick.cherrypick(theRepo, commit, {});
	})
	.then(function(rc) {
		theRC = rc;
		if (rc) return;
		return createCommit(theRepo, null, null, theCommit.author().name(), theCommit.author().email(), theCommit.message());
		//TODO: Update Reflog to Cherry-Pick
	})
	.then(function() {
		return theRepo.stateCleanup();
	})
	.then(function() {
		return git.Reference.nameToId(theRepo, "HEAD");
	})
	.then(function(newHead) {
		res.statusCode = 200;
		var resp = JSON.stringify({
			"Result": theRC ? "FAILED" : "OK",
			"HeadUpdated": !theRC && theHead !== newHead
		});
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	})
	.catch(function(err) {
		writeError(400, res, err.message);
	});
}

function rebase(req, res, next, rest, repoPath, commitToRebase, rebaseOperation) {
	var repo, head, commit, oid, paths;
	
	git.Repository.open(repoPath)
	.then(function(_repo) {
		repo = _repo;
		return repo.getHeadCommit();
	})
	.then(function(_head) {
		head = _head;
		return commitToRebase ? repo.getReferenceCommit(commitToRebase) : head;
	})
	.then(function(_commit) {
		commit = _commit;
		var work;
		switch (rebaseOperation) {
			case "ABORT":
				work = git.Rebase.open(repo, {}).then(function(rebase){
					return rebase.abort();
				});
				break;
				
			case "CONTINUE":
				work = repo.continueRebase();
				break;
				
			case "SKIP":
				throw new Error("Not implemented yet");
				
			default:
				work = repo.rebaseBranches("HEAD", commitToRebase, null, null, null);
		}
		return work
		.then(function(_oid) {
			oid = _oid;
		})
		.catch(function(index) {
			if (rebaseOperation === "ABORT") {
				throw index;
			}
			paths = {};
			index.entries().forEach(function(entry) {
				if (git.Index.entryIsConflict(entry)) {
					paths[entry.path] = "";
				}
			});
			return git.Checkout.index(repo, index, {
				checkoutStrategy: git.Checkout.STRATEGY.ALLOW_CONFLICTS,
				ourLabel: "HEAD",
				theirLabel: commit.sha()
			});
		});
	})
	.then(function() {
		res.statusCode = 200;
		var rebaseResult = rebaseOperation && paths ? "STOPPED" : "OK";
		
		if (rebaseOperation !== "ABORT") {
			if (!paths) {
				if (oid && oid.toString() === head.id().toString()) rebaseResult = "UP_TO_DATE";
				else if (oid && oid.toString() === commit.id().toString()) rebaseResult = "FAST_FORWARD";
			} else if (rebaseOperation !== "BEGIN") {
				rebaseResult = "FAILED_UNMERGED_PATHS";
			}
		} else if (rebaseOperation === "ABORT") {
			rebaseResult = "ABORTED";
		}
		var result = {
			"Result": rebaseResult
		};
		var resp = JSON.stringify(result);
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	})
	.catch(function(err) {
		writeError(400, res, err.message);
	});

}

function merge(req, res, next, rest, repoPath, commitToMerge, squash) {
	
	var repo, head, commit, oid, paths;
	git.Repository.open(repoPath)
	.then(function(_repo) {
		repo = _repo;
		return repo.getHeadCommit();
	})
	.then(function(_head) {
		head = _head;
		return repo.getReferenceCommit(commitToMerge);
	})
	.then(function(_commit) {
		commit = _commit;
		if (squash) {
			throw new Error("Not implemented yet");
		}
		return repo.mergeBranches("HEAD", commitToMerge)
		.then(function(_oid) {
			oid = _oid;
		})
		.catch(function(index) {
			paths = {};
			index.entries().forEach(function(entry) {
				if (git.Index.entryIsConflict(entry)) {
					paths[entry.path] = "";
				}
			});
			return git.Checkout.index(repo, index, {
				checkoutStrategy: git.Checkout.STRATEGY.ALLOW_CONFLICTS,
				ourLabel: "HEAD",
				theirLabel: commit.sha()
			});
		});
	})
	.then(function() {
		res.statusCode = 200;
		var mergeResult = "MERGED";
		if (!paths) {
			if (oid && oid.toString() === head.id().toString()) mergeResult = "ALREADY_UPDATE";
			else if (oid && oid.toString() === commit.id().toString()) mergeResult = "FAST_FORWARD";
		}
		var result = {
			"Result": paths ? "CONFLICTING" : mergeResult,
			"FailingPaths": paths
		};
		var resp = JSON.stringify(result);
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	})
	.catch(function(err) {
		writeError(400, res, err.message);
	});
}

function createCommit(repo, committerName, committerEmail, authorName, authorEmail, message, amend){
	var index, oid, author, committer;
	return repo.index()
	.then(function(indexResult) {
		index = indexResult;
		return index.read(1);
	})
	.then(function() {
		return index.writeTree();
	})
	.then(function(oidResult) {
		oid = oidResult;
		return git.Reference.nameToId(repo, "HEAD");
	})
	.then(function(head) {
		return repo.getCommit(head);
	})
	.then(function(parent) {
		if (authorEmail) {
			author = git.Signature.now(authorName, authorEmail);
		} else {
			author = git.Signature.default(repo);	
		}
		if (committerEmail) {
			committer = git.Signature.now(committerName, committerEmail);
		} else {
			committer = git.Signature.default(repo);
		}
		if (amend) {
			return parent.amend("HEAD",  author, committer, null, message, oid);
		}
		return repo.createCommit("HEAD", author, committer, message, oid, [parent]);
	})
	.then(function(id) {
		return git.Commit.lookup(repo, id);
	});
}

function tag(req, res, next, rest, repoPath, fileDir, commitId, name) {
	var theRepo, theDiffs, thisCommit, theParents;
	git.Repository.open(repoPath)
	.then(function(repo) {
		theRepo = repo;
		return git.Commit.lookup(repo, commitId);
	})
	.then(function(commit) {
		thisCommit = commit;
		return theRepo.createLightweightTag(commit, name);
	})
	.then(function() {
		return getDiff(theRepo, thisCommit, fileDir);
	})
	.then(function(diffs){
		theDiffs = diffs;
	})
	.then(function() {
		return getCommitParents(theRepo, thisCommit, fileDir);
	})
	.then(function(parents){
		theParents = parents;
	})
	.catch(function(err) {
		writeError(403, res, err.message);
	})
	.done(function() {
		res.statusCode = 200;
		var resp = commitJSON(thisCommit, fileDir, theDiffs, theParents);
		resp = JSON.stringify(resp);
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	});
}

function putCommit(workspaceDir, fileRoot, req, res, next, rest) {
	var segments = rest.split("/");
	var commit = segments[1].replace(/%252F/g, '/');
	var repoPath = segments[3];
	var fileDir = api.join(fileRoot, repoPath);
	repoPath = api.join(workspaceDir, repoPath);
	var tagName = req.body.Name;
	if (tagName) {
		tag(req, res, next, rest, repoPath, fileDir, commit, tagName);
	}
}

function postCommit(workspaceDir, fileRoot, req, res, next, rest) {
	var segments = rest.split("/");
	var commit = segments[1].replace(/%252F/g, '/');
	var repoPath = segments[3];
	var fileDir = api.join(fileRoot, repoPath);
	repoPath = api.join(workspaceDir, repoPath);
	if (typeof req.body.Merge === "string") {
		merge(req, res, next, rest, repoPath, req.body.Merge, req.body.Squash);
		return;
	}
	if (typeof req.body.Rebase === "string") {
		rebase(req, res, next, rest, repoPath, req.body.Rebase, req.body.Operation);
		return;
	}
	if (typeof req.body["Cherry-Pick"] === "string") {
		cherryPick(req, res, next, rest, repoPath, req.body["Cherry-Pick"]);
		return;
	}
	if (typeof req.body.Revert === "string") {
		revert(req, res, next, rest, repoPath, req.body.Revert);
		return;
	}
	if (typeof req.body.New === "string") {
		identifyNewCommitResource(req, res, next, rest, commit, req.body.New, segments);
		return;
	}
	
	//TODO create commit -> change id
	if (commit !== "HEAD") {
		writeError(404, res, "Needs to be HEAD");
		return;
	}
	
	if (!req.body.Message) {
		writeError(404, res, "Commit message cannot be empty.");
		return;
	}

	var theRepo, thisCommit;
	var theDiffs = [], theParents;
	
	git.Repository.open(repoPath)
	.then(function(repo) {
		theRepo = repo;
		return createCommit(repo, req.body.CommitterName, req.body.CommitterEmail, req.body.AuthorName, req.body.AuthorEmail, req.body.Message, req.body.Amend);
	})
	.then(function(commit) {
		thisCommit = commit;
		return getDiff(theRepo, commit, fileDir);
	})
	.then(function(diffs){
		theDiffs = diffs;
	})
	.then(function() {
		return getCommitParents(theRepo, thisCommit, fileDir);
	})
	.then(function(parents){
		theParents = parents;
	})
	.catch(function(err) {
		writeError(403, res, err.message);
	})
	.done(function() {
		res.statusCode = 200;
		var resp = commitJSON(thisCommit, fileDir, theDiffs, theParents);
		resp = JSON.stringify(resp);
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Content-Length', resp.length);
		res.end(resp);
	});
}

module.exports = {
	getCommit: getCommit,
	putCommit: putCommit,
	postCommit: postCommit,
	
	commitJSON: commitJSON,
	getDiff: getDiff,
	getCommitParents: getCommitParents
};