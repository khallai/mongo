// Basic $lookup regression tests.
(function() {
    "use strict";

    load("jstests/aggregation/extras/utils.js");  // For assertErrorCode.

    const st = new ShardingTest({shards: 2, config: 1, mongos: 1});
    const testName = "lookup_sharded";

    const mongosDB = st.s0.getDB(testName);
    assert.commandWorked(mongosDB.dropDatabase());

    // Used by testPipeline to sort result documents. All _ids must be primitives.
    function compareId(a, b) {
        if (a._id < b._id) {
            return -1;
        }
        if (a._id > b._id) {
            return 1;
        }
        return 0;
    }

    // Helper for testing that pipeline returns correct set of results.
    function testPipeline(pipeline, expectedResult, collection) {
        assert.eq(collection.aggregate(pipeline).toArray().sort(compareId),
                  expectedResult.sort(compareId));
    }

    // Shards and splits the collection 'coll' on _id.
    function shardAndSplit(db, coll) {
        // Shard the collection on _id.
        assert.commandWorked(db.adminCommand({shardCollection: coll.getFullName(), key: {_id: 1}}));

        // Split the collection into 2 chunks: [MinKey, 0), [0, MaxKey).
        assert.commandWorked(db.adminCommand({split: coll.getFullName(), middle: {_id: 0}}));

        // Move the [0, MaxKey) chunk to shard0001.
        assert.commandWorked(db.adminCommand({
            moveChunk: coll.getFullName(),
            find: {_id: 1},
            to: st.shard1.shardName,
        }));
    }

    function runTest(coll, from, thirdColl, fourthColl) {
        let db = null;  // Using the db variable is banned in this function.

        coll.remove({});
        from.remove({});
        thirdColl.remove({});
        fourthColl.remove({});

        assert.writeOK(coll.insert({_id: 0, a: 1}));
        assert.writeOK(coll.insert({_id: 1, a: null}));
        assert.writeOK(coll.insert({_id: 2}));

        assert.writeOK(from.insert({_id: 0, b: 1}));
        assert.writeOK(from.insert({_id: 1, b: null}));
        assert.writeOK(from.insert({_id: 2}));
        //
        // Basic functionality.
        //

        // "from" document added to "as" field if a == b, where nonexistent fields are treated as
        // null.
        let expectedResults = [
            {_id: 0, a: 1, "same": [{_id: 0, b: 1}]},
            {_id: 1, a: null, "same": [{_id: 1, b: null}, {_id: 2}]},
            {_id: 2, "same": [{_id: 1, b: null}, {_id: 2}]}
        ];
        testPipeline([{$lookup: {localField: "a", foreignField: "b", from: "from", as: "same"}}],
                     expectedResults,
                     coll);

        // If localField is nonexistent, it is treated as if it is null.
        expectedResults = [
            {_id: 0, a: 1, "same": [{_id: 1, b: null}, {_id: 2}]},
            {_id: 1, a: null, "same": [{_id: 1, b: null}, {_id: 2}]},
            {_id: 2, "same": [{_id: 1, b: null}, {_id: 2}]}
        ];
        testPipeline(
            [{$lookup: {localField: "nonexistent", foreignField: "b", from: "from", as: "same"}}],
            expectedResults,
            coll);

        // If foreignField is nonexistent, it is treated as if it is null.
        expectedResults = [
            {_id: 0, a: 1, "same": []},
            {_id: 1, a: null, "same": [{_id: 0, b: 1}, {_id: 1, b: null}, {_id: 2}]},
            {_id: 2, "same": [{_id: 0, b: 1}, {_id: 1, b: null}, {_id: 2}]}
        ];
        testPipeline(
            [{$lookup: {localField: "a", foreignField: "nonexistent", from: "from", as: "same"}}],
            expectedResults,
            coll);

        // If there are no matches or the from coll doesn't exist, the result is an empty array.
        expectedResults =
            [{_id: 0, a: 1, "same": []}, {_id: 1, a: null, "same": []}, {_id: 2, "same": []}];
        testPipeline(
            [{$lookup: {localField: "_id", foreignField: "nonexistent", from: "from", as: "same"}}],
            expectedResults,
            coll);
        testPipeline(
            [{$lookup: {localField: "a", foreignField: "b", from: "nonexistent", as: "same"}}],
            expectedResults,
            coll);

        // If field name specified by "as" already exists, it is overwritten.
        expectedResults = [
            {_id: 0, "a": [{_id: 0, b: 1}]},
            {_id: 1, "a": [{_id: 1, b: null}, {_id: 2}]},
            {_id: 2, "a": [{_id: 1, b: null}, {_id: 2}]}
        ];
        testPipeline([{$lookup: {localField: "a", foreignField: "b", from: "from", as: "a"}}],
                     expectedResults,
                     coll);

        // Running multiple $lookups in the same pipeline is allowed.
        expectedResults = [
            {_id: 0, a: 1, "c": [{_id: 0, b: 1}], "d": [{_id: 0, b: 1}]},
            {
              _id: 1,
              a: null, "c": [{_id: 1, b: null}, {_id: 2}], "d": [{_id: 1, b: null}, {_id: 2}]
            },
            {_id: 2, "c": [{_id: 1, b: null}, {_id: 2}], "d": [{_id: 1, b: null}, {_id: 2}]}
        ];
        testPipeline(
            [
              {$lookup: {localField: "a", foreignField: "b", from: "from", as: "c"}},
              {$project: {"a": 1, "c": 1}},
              {$lookup: {localField: "a", foreignField: "b", from: "from", as: "d"}}
            ],
            expectedResults,
            coll);

        //
        // Coalescing with $unwind.
        //

        // A normal $unwind with on the "as" field.
        expectedResults = [
            {_id: 0, a: 1, same: {_id: 0, b: 1}},
            {_id: 1, a: null, same: {_id: 1, b: null}},
            {_id: 1, a: null, same: {_id: 2}},
            {_id: 2, same: {_id: 1, b: null}},
            {_id: 2, same: {_id: 2}}
        ];
        testPipeline(
            [
              {$lookup: {localField: "a", foreignField: "b", from: "from", as: "same"}},
              {$unwind: {path: "$same"}}
            ],
            expectedResults,
            coll);

        // An $unwind on the "as" field, with includeArrayIndex.
        expectedResults = [
            {_id: 0, a: 1, same: {_id: 0, b: 1}, index: NumberLong(0)},
            {_id: 1, a: null, same: {_id: 1, b: null}, index: NumberLong(0)},
            {_id: 1, a: null, same: {_id: 2}, index: NumberLong(1)},
            {_id: 2, same: {_id: 1, b: null}, index: NumberLong(0)},
            {_id: 2, same: {_id: 2}, index: NumberLong(1)},
        ];
        testPipeline(
            [
              {$lookup: {localField: "a", foreignField: "b", from: "from", as: "same"}},
              {$unwind: {path: "$same", includeArrayIndex: "index"}}
            ],
            expectedResults,
            coll);

        // Normal $unwind with no matching documents.
        expectedResults = [];
        testPipeline(
            [
              {$lookup: {localField: "_id", foreignField: "nonexistent", from: "from", as: "same"}},
              {$unwind: {path: "$same"}}
            ],
            expectedResults,
            coll);

        // $unwind with preserveNullAndEmptyArray with no matching documents.
        expectedResults = [
            {_id: 0, a: 1},
            {_id: 1, a: null},
            {_id: 2},
        ];
        testPipeline(
            [
              {$lookup: {localField: "_id", foreignField: "nonexistent", from: "from", as: "same"}},
              {$unwind: {path: "$same", preserveNullAndEmptyArrays: true}}
            ],
            expectedResults,
            coll);

        // $unwind with preserveNullAndEmptyArray, some with matching documents, some without.
        expectedResults = [
            {_id: 0, a: 1},
            {_id: 1, a: null, same: {_id: 0, b: 1}},
            {_id: 2},
        ];
        testPipeline(
            [
              {$lookup: {localField: "_id", foreignField: "b", from: "from", as: "same"}},
              {$unwind: {path: "$same", preserveNullAndEmptyArrays: true}}
            ],
            expectedResults,
            coll);

        // $unwind with preserveNullAndEmptyArray and includeArrayIndex, some with matching
        // documents, some without.
        expectedResults = [
            {_id: 0, a: 1, index: null},
            {_id: 1, a: null, same: {_id: 0, b: 1}, index: NumberLong(0)},
            {_id: 2, index: null},
        ];
        testPipeline(
            [
              {$lookup: {localField: "_id", foreignField: "b", from: "from", as: "same"}},
              {
                $unwind:
                    {path: "$same", preserveNullAndEmptyArrays: true, includeArrayIndex: "index"}
              }
            ],
            expectedResults,
            coll);

        //
        // Dependencies.
        //

        // If $lookup didn't add "localField" to its dependencies, this test would fail as the
        // value of the "a" field would be lost and treated as null.
        expectedResults = [
            {_id: 0, "same": [{_id: 0, b: 1}]},
            {_id: 1, "same": [{_id: 1, b: null}, {_id: 2}]},
            {_id: 2, "same": [{_id: 1, b: null}, {_id: 2}]}
        ];
        testPipeline(
            [
              {$lookup: {localField: "a", foreignField: "b", from: "from", as: "same"}},
              {$project: {"same": 1}}
            ],
            expectedResults,
            coll);

        // If $lookup didn't add fields referenced by "let" variables to its dependencies, this test
        // would fail as the value of the "a" field would be lost and treated as null.
        expectedResults = [
            {"_id": 0, "same": [{"_id": 0, "x": 1}, {"_id": 1, "x": 1}, {"_id": 2, "x": 1}]},
            {
              "_id": 1,
              "same": [{"_id": 0, "x": null}, {"_id": 1, "x": null}, {"_id": 2, "x": null}]
            },
            {"_id": 2, "same": [{"_id": 0}, {"_id": 1}, {"_id": 2}]}
        ];
        testPipeline(
            [
              {
                $lookup: {
                    let : {var1: "$a"},
                    pipeline: [{$project: {x: "$$var1"}}],
                    from: "from",
                    as: "same"
                }
              },
              {$project: {"same": 1}}
            ],
            expectedResults,
            coll);

        //
        // Dotted field paths.
        //

        coll.remove({});
        assert.writeOK(coll.insert({_id: 0, a: 1}));
        assert.writeOK(coll.insert({_id: 1, a: null}));
        assert.writeOK(coll.insert({_id: 2}));
        assert.writeOK(coll.insert({_id: 3, a: {c: 1}}));

        from.remove({});
        assert.writeOK(from.insert({_id: 0, b: 1}));
        assert.writeOK(from.insert({_id: 1, b: null}));
        assert.writeOK(from.insert({_id: 2}));
        assert.writeOK(from.insert({_id: 3, b: {c: 1}}));
        assert.writeOK(from.insert({_id: 4, b: {c: 2}}));

        // Once without a dotted field.
        let pipeline = [{$lookup: {localField: "a", foreignField: "b", from: "from", as: "same"}}];
        expectedResults = [
            {_id: 0, a: 1, "same": [{_id: 0, b: 1}]},
            {_id: 1, a: null, "same": [{_id: 1, b: null}, {_id: 2}]},
            {_id: 2, "same": [{_id: 1, b: null}, {_id: 2}]},
            {_id: 3, a: {c: 1}, "same": [{_id: 3, b: {c: 1}}]}
        ];
        testPipeline(pipeline, expectedResults, coll);

        // Look up a dotted field.
        pipeline = [{$lookup: {localField: "a.c", foreignField: "b.c", from: "from", as: "same"}}];
        // All but the last document in 'coll' have a nullish value for 'a.c'.
        expectedResults = [
            {_id: 0, a: 1, same: [{_id: 0, b: 1}, {_id: 1, b: null}, {_id: 2}]},
            {_id: 1, a: null, same: [{_id: 0, b: 1}, {_id: 1, b: null}, {_id: 2}]},
            {_id: 2, same: [{_id: 0, b: 1}, {_id: 1, b: null}, {_id: 2}]},
            {_id: 3, a: {c: 1}, same: [{_id: 3, b: {c: 1}}]}
        ];
        testPipeline(pipeline, expectedResults, coll);

        // With an $unwind stage.
        coll.remove({});
        assert.writeOK(coll.insert({_id: 0, a: {b: 1}}));
        assert.writeOK(coll.insert({_id: 1}));

        from.remove({});
        assert.writeOK(from.insert({_id: 0, target: 1}));

        pipeline = [
            {
              $lookup: {
                  localField: "a.b",
                  foreignField: "target",
                  from: "from",
                  as: "same.documents",
              }
            },
            {
              // Expected input to $unwind:
              // {_id: 0, a: {b: 1}, same: {documents: [{_id: 0, target: 1}]}}
              // {_id: 1, same: {documents: []}}
              $unwind: {
                  path: "$same.documents",
                  preserveNullAndEmptyArrays: true,
                  includeArrayIndex: "c.d.e",
              }
            }
        ];
        expectedResults = [
            {_id: 0, a: {b: 1}, same: {documents: {_id: 0, target: 1}}, c: {d: {e: NumberLong(0)}}},
            {_id: 1, same: {}, c: {d: {e: null}}},
        ];
        testPipeline(pipeline, expectedResults, coll);

        //
        // Query-like local fields (SERVER-21287)
        //

        // This must only do an equality match rather than treating the value as a regex.
        coll.remove({});
        assert.writeOK(coll.insert({_id: 0, a: /a regex/}));

        from.remove({});
        assert.writeOK(from.insert({_id: 0, b: /a regex/}));
        assert.writeOK(from.insert({_id: 1, b: "string that matches /a regex/"}));

        pipeline = [
            {
              $lookup: {
                  localField: "a",
                  foreignField: "b",
                  from: "from",
                  as: "b",
              }
            },
        ];
        expectedResults = [{_id: 0, a: /a regex/, b: [{_id: 0, b: /a regex/}]}];
        testPipeline(pipeline, expectedResults, coll);

        //
        // A local value of an array.
        //

        // Basic array corresponding to multiple documents.
        coll.remove({});
        assert.writeOK(coll.insert({_id: 0, a: [0, 1, 2]}));

        from.remove({});
        assert.writeOK(from.insert({_id: 0}));
        assert.writeOK(from.insert({_id: 1}));

        pipeline = [
            {
              $lookup: {
                  localField: "a",
                  foreignField: "_id",
                  from: "from",
                  as: "b",
              }
            },
        ];
        expectedResults = [{_id: 0, a: [0, 1, 2], b: [{_id: 0}, {_id: 1}]}];
        testPipeline(pipeline, expectedResults, coll);

        // Basic array corresponding to a single document.
        coll.remove({});
        assert.writeOK(coll.insert({_id: 0, a: [1]}));

        from.remove({});
        assert.writeOK(from.insert({_id: 0}));
        assert.writeOK(from.insert({_id: 1}));

        pipeline = [
            {
              $lookup: {
                  localField: "a",
                  foreignField: "_id",
                  from: "from",
                  as: "b",
              }
            },
        ];
        expectedResults = [{_id: 0, a: [1], b: [{_id: 1}]}];
        testPipeline(pipeline, expectedResults, coll);

        // Array containing regular expressions.
        coll.remove({});
        assert.writeOK(coll.insert({_id: 0, a: [/a regex/, /^x/]}));
        assert.writeOK(coll.insert({_id: 1, a: [/^x/]}));

        from.remove({});
        assert.writeOK(from.insert({_id: 0, b: "should not match a regex"}));
        assert.writeOK(from.insert({_id: 1, b: "xxxx"}));
        assert.writeOK(from.insert({_id: 2, b: /a regex/}));
        assert.writeOK(from.insert({_id: 3, b: /^x/}));

        pipeline = [
            {
              $lookup: {
                  localField: "a",
                  foreignField: "b",
                  from: "from",
                  as: "b",
              }
            },
        ];
        expectedResults = [
            {_id: 0, a: [/a regex/, /^x/], b: [{_id: 2, b: /a regex/}, {_id: 3, b: /^x/}]},
            {_id: 1, a: [/^x/], b: [{_id: 3, b: /^x/}]}
        ];
        testPipeline(pipeline, expectedResults, coll);

        // 'localField' references a field within an array of sub-objects.
        coll.remove({});
        assert.writeOK(coll.insert({_id: 0, a: [{b: 1}, {b: 2}]}));

        from.remove({});
        assert.writeOK(from.insert({_id: 0}));
        assert.writeOK(from.insert({_id: 1}));
        assert.writeOK(from.insert({_id: 2}));
        assert.writeOK(from.insert({_id: 3}));

        pipeline = [
            {
              $lookup: {
                  localField: "a.b",
                  foreignField: "_id",
                  from: "from",
                  as: "c",
              }
            },
        ];

        expectedResults = [{"_id": 0, "a": [{"b": 1}, {"b": 2}], "c": [{"_id": 1}, {"_id": 2}]}];
        testPipeline(pipeline, expectedResults, coll);

        //
        // Test $lookup when the foreign collection is a view.
        //
        // TODO: Enable this test as part of SERVER-32548, fails whenever the foreign collection is
        // sharded.
        // coll.getDB().fromView.drop();
        // assert.commandWorked(
        //     coll.getDB().runCommand({create: "fromView", viewOn: "from", pipeline: []}));

        // pipeline = [
        //     {
        //       $lookup: {
        //           localField: "a.b",
        //           foreignField: "_id",
        //           from: "fromView",
        //           as: "c",
        //       }
        //     },
        // ];

        // expectedResults = [{"_id": 0, "a": [{"b": 1}, {"b": 2}], "c": [{"_id": 1}, {"_id": 2}]}];
        // testPipeline(pipeline, expectedResults, coll);

        //
        // Error cases.
        //

        // 'from', 'as', 'localField' and 'foreignField' must all be specified when run with
        // localField/foreignField syntax.
        assertErrorCode(coll,
                        [{$lookup: {foreignField: "b", from: "from", as: "same"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {localField: "a", from: "from", as: "same"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {localField: "a", foreignField: "b", as: "same"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {localField: "a", foreignField: "b", from: "from"}}],
                        ErrorCodes.FailedToParse);

        // localField/foreignField and pipeline/let syntax must not be mixed.
        assertErrorCode(coll,
                        [{$lookup: {pipeline: [], foreignField: "b", from: "from", as: "as"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {pipeline: [], localField: "b", from: "from", as: "as"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(
            coll,
            [{$lookup: {pipeline: [], localField: "b", foreignField: "b", from: "from", as: "as"}}],
            ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {let : {a: "$b"}, foreignField: "b", from: "from", as: "as"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {let : {a: "$b"}, localField: "b", from: "from", as: "as"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(
            coll,
            [{
               $lookup:
                   {let : {a: "$b"}, localField: "b", foreignField: "b", from: "from", as: "as"}
            }],
            ErrorCodes.FailedToParse);

        // 'from', 'as', 'localField' and 'foreignField' must all be of type string.
        assertErrorCode(coll,
                        [{$lookup: {localField: 1, foreignField: "b", from: "from", as: "as"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {localField: "a", foreignField: 1, from: "from", as: "as"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {localField: "a", foreignField: "b", from: 1, as: "as"}}],
                        ErrorCodes.FailedToParse);
        assertErrorCode(coll,
                        [{$lookup: {localField: "a", foreignField: "b", from: "from", as: 1}}],
                        ErrorCodes.FailedToParse);

        // The foreign collection must be a valid namespace.
        assertErrorCode(coll,
                        [{$lookup: {localField: "a", foreignField: "b", from: "", as: "as"}}],
                        ErrorCodes.InvalidNamespace);
        // $lookup's field must be an object.
        assertErrorCode(coll, [{$lookup: "string"}], ErrorCodes.FailedToParse);
    }

    //
    // Test unsharded local collection and unsharded foreign collection.
    //
    mongosDB.lookUp.drop();
    mongosDB.from.drop();
    mongosDB.thirdColl.drop();
    mongosDB.fourthColl.drop();

    runTest(mongosDB.lookUp, mongosDB.from, mongosDB.thirdColl, mongosDB.fourthColl);

    // Verify that the command is sent only to the primary shard when both the local and foreign
    // collections are unsharded.
    assert(!assert
                .commandWorked(mongosDB.lookup.explain().aggregate([{
                    $lookup: {
                        from: mongosDB.from.getName(),
                        localField: "a",
                        foreignField: "b",
                        as: "results"
                    }
                }]))
                .hasOwnProperty("shards"));
    // Enable sharding on the test DB and ensure its primary is shard0000.
    assert.commandWorked(mongosDB.adminCommand({enableSharding: mongosDB.getName()}));
    st.ensurePrimaryShard(mongosDB.getName(), st.shard0.shardName);

    //
    // Test unsharded local collection and sharded foreign collection.
    //

    // Shard the foreign collection on _id.
    shardAndSplit(mongosDB, mongosDB.from);
    runTest(mongosDB.lookUp, mongosDB.from, mongosDB.thirdColl, mongosDB.fourthColl);

    //
    // Test sharded local collection and unsharded foreign collection.
    //
    mongosDB.from.drop();

    // Shard the local collection on _id.
    shardAndSplit(mongosDB, mongosDB.lookup);
    runTest(mongosDB.lookUp, mongosDB.from, mongosDB.thirdColl, mongosDB.fourthColl);

    //
    // Test sharded local and foreign collections.
    //

    // Shard the foreign collection on _id.
    shardAndSplit(mongosDB, mongosDB.from);
    runTest(mongosDB.lookUp, mongosDB.from, mongosDB.thirdColl, mongosDB.fourthColl);

    st.stop();
}());