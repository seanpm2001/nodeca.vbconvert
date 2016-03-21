// Convert sections
//

'use strict';

const co      = require('co');
const Promise = require('bluebird');

// forum permissions
const can_view_forum             = 1;
const can_post_threads           = 16;
const can_open_close_own_threads = 1024;

// forum options
const forum_active = 1;


/* eslint-disable no-bitwise */
module.exports = co.wrap(function* (N) {
  let conn = yield N.vbconvert.getConnection();

  // select all sections except link-only
  let rows = yield conn.query(`
    SELECT forumid,title,description,options,parentid,displayorder
    FROM forum
    WHERE link = ''
    ORDER BY forumid ASC
  `);

  //
  // Create sections
  //
  yield rows.map(co.wrap(function* (row) {
    // ignoring one inactive forum: vBCms Comments
    if (!(row.options & forum_active)) return;

    let existing_section = yield N.models.forum.Section.findOne({ hid: row.forumid });

    // section with this id is already imported
    if (existing_section) return;

    let section = new N.models.forum.Section();

    section.hid           = row.forumid;
    section.title         = row.title;
    section.description   = row.description;
    section.display_order = row.displayorder;
    section.is_category   = false;

    yield section.save();
  }));


  //
  // Link each section with its parent
  //
  yield rows.map(co.wrap(function* (row) {
    // top-level forum
    if (row.parentid < 0) return;

    let parent = yield N.models.forum.Section.findOne({ hid: row.parentid });

    yield N.models.forum.Section.update(
      { hid: row.forumid },
      { $set: { parent: parent._id } }
    );

    yield N.models.core.Increment.update(
      { key: 'section' },
      { $set: { value: rows[rows.length - 1].forumid } },
      { upsert: true }
    );
  }));

  //
  // Set usergroup permissions
  //

  let permissions = yield conn.query(`
    SELECT forumid,usergroupid,forumpermissions
    FROM forumpermission
  `);

  let store = N.settings.getStore('section_usergroup');

  if (!store) throw 'Settings store `section_usergroup` is not registered.';

  yield Promise.map(permissions, co.wrap(function* (row) {
    let section  = yield N.models.forum.Section.findOne({ hid: row.forumid });
    let groupmap = yield N.models.vbconvert.UserGroupMapping.findOne({ mysql: row.usergroupid });

    if (!section || !groupmap) return;

    yield store.set({
      forum_can_view:         { value: !!(row.forumpermissions & can_view_forum) },
      forum_can_reply:        { value: !!(row.forumpermissions & can_post_threads) },
      forum_can_start_topics: { value: !!(row.forumpermissions & can_post_threads) },
      forum_can_close_topic:  { value: !!(row.forumpermissions & can_open_close_own_threads) }
    }, { section_id: section._id, usergroup_id: groupmap.mongo });

  // fix concurrency to 1 to avoid races
  }), { concurrency: 1 });

  yield store.updateInherited();

  conn.release();
  N.logger.info('Section import finished');
});
