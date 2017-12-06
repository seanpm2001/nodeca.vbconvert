// Import blog entries
//

'use strict';


const _             = require('lodash');
const mongoose      = require('mongoose');
const memoize       = require('promise-memoize');
const html_unescape = require('nodeca.vbconvert/lib/html_unescape_entities');
const progress      = require('./utils').progress;

// blog options
const blog_private = 8;


module.exports = async function (N) {
  let conn = await N.vbconvert.getConnection();

  const get_user_by_hid = memoize(function (hid) {
    return N.models.users.User.findOne({ hid }).lean(true);
  });

  const get_default_usergroup = memoize(function () {
    return N.models.users.UserGroup.findOne({ short_name: 'members' }).lean(true);
  });

  const get_parser_param_id = memoize(function (usergroup_ids, allowsmilie) {
    return N.settings.getByCategory(
      'blog_entries_markup',
      { usergroup_ids },
      { alias: true }
    ).then(params => {
      // make sure quotes are not collapsed in imported messages
      params.quote_collapse = false;

      if (!allowsmilie) {
        params.emoji = false;
      }

      return N.models.core.MessageParams.setParams(params);
    });
  });

  // title       - tag/category title
  // user_id     - user id
  // dateline    - post dateline (tags are created with the first post they're in)
  const create_tag = memoize(async function (title, user_id, dateline) {
    title = title.trim().toLowerCase().replace(/\s+/, ' ').replace(/^\s+|\s+$/g, '');

    let existing_tag = await N.models.blogs.BlogTag.findOne()
                                 .where('user').equals(user_id)
                                 .where('name').equals(title)
                                 .lean(true);

    if (existing_tag) return existing_tag.hid;

    let new_tag = await N.models.blogs.BlogTag.create({
      _id: new mongoose.Types.ObjectId(dateline),
      name: title,
      user: user_id,
      is_category: false
    });

    return new_tag.hid;
  }, {
    resolve: [ String, String ] // don't include dateline in key
  });


  function normalize_tag(name) {
    return N.models.blogs.BlogTag.normalize(html_unescape(name).replace(/,/g, ' '));
  }

  //
  // Import categories
  //
  let store = N.settings.getStore('user');

  for (let { userid } of (await conn.query('SELECT DISTINCT userid FROM blog_category'))[0]) {
    let user = await get_user_by_hid(userid);
    if (!user) continue;

    let categories = (await conn.query(`
      SELECT * FROM blog_category WHERE userid = ?
      ORDER BY displayorder ASC, blogcategoryid ASC
    `, [ userid ]))[0];

    await store.set({
      blogs_categories: { value: categories.map(c => normalize_tag(c.title)).join(',') }
    }, { user_id: user._id });

    for (let category of categories) {
      let hid = await create_tag(normalize_tag(category.title), user._id);

      let tag = await N.models.blogs.BlogTag.findOneAndUpdate(
                  { hid },
                  { $set: { is_category: true } },
                  { 'new': true }
                ).lean(true);

      await N.models.vbconvert.BlogCategoryMapping.findOneAndUpdate(
        { mysql: category.blogcategoryid },
        { $set: { mongo: tag._id } },
        { upsert: true }
      ).lean(true);
    }
  }

  //
  // Import blogs
  //
  let category_titles = {};

  for (let c of (await conn.query('SELECT blogcategoryid,title FROM blog_category'))[0]) {
    category_titles[c.blogcategoryid] = normalize_tag(c.title);
  }

  let blogids = _.map((await conn.query('SELECT blogid FROM blog ORDER BY blogid ASC'))[0], 'blogid');

  let bar = progress(' blog entries :current/:total :percent', blogids.length);

  for (let blogid of blogids) {
    bar.tick();

    let row = (await conn.query(`
      SELECT blog.blogid,blog.userid,blog.dateline,blog.pending,blog.state,
             blog.title,blog.taglist,blog.categories,blog.views,
             blog_text.blogtextid,blog_text.ipaddress,blog_text.pagetext,
             blog_text.allowsmilie
      FROM blog JOIN blog_text USING(blogid)
      WHERE blog.firstblogtextid = blog_text.blogtextid
        AND blogid = ?
    `, [ blogid ]))[0][0];

    // only import visible entries
    /* eslint-disable no-bitwise */
    if (row.state !== 'visible' || (row.options & blog_private) || row.pending) {
      //  - drafts (state=draft)
      //  - deleted blogs (state=deleted)
      //  - private blogs (options & 8)
      //  - pending entries
      continue;
    }

    let existing_mapping = await N.models.vbconvert.BlogTextMapping.findOne()
                                     .where('blogtextid').equals(row.blogtextid)
                                     .lean(true);

    // blog entry with this id is already imported
    if (existing_mapping) continue;

    let user = await get_user_by_hid(row.userid);
    let user_id = user ? user._id : new mongoose.Types.ObjectId('000000000000000000000000');

    if (user && !user.active) {
      user.active = true;

      await N.models.users.User.update({ _id: user._id }, { $set: { active: true } });
    }

    let params_id = await get_parser_param_id(
      (user && user.usergroups) ? user.usergroups : [ (await get_default_usergroup())._id ],
      row.allowsmilie
    );

    let entry = new N.models.blogs.BlogEntry();

    entry._id        = new mongoose.Types.ObjectId(row.dateline);
    entry.hid        = row.blogid;
    entry.title      = html_unescape(row.title);
    entry.user       = user_id;
    entry.md         = row.pagetext;
    entry.html       = '<p>' + _.escape(row.pagetext) + '</p>';
    entry.ts         = new Date(row.dateline * 1000);
    entry.views      = row.views;
    entry.params_ref = params_id;

    let tag_source = '';

    if (row.categories) tag_source += row.categories.split(',').map(id => category_titles[id]).join(', ');
    if (row.taglist) tag_source += (tag_source ? ', ' : '') + html_unescape(row.taglist);

    if (tag_source.length) {
      entry.tag_source = tag_source;
    }

    let tag_hids = [];

    if (row.categories) {
      for (let id of row.categories.split(',')) {
        tag_hids.push(await create_tag(category_titles[id], user, row.dateline));
      }
    }

    if (row.taglist) {
      for (let title of row.taglist.split(',')) {
        tag_hids.push(await create_tag(title, user, row.dateline));
      }
    }

    if (tag_hids.length) {
      entry.tag_hids = _.uniq(tag_hids);
    }

    let ip = row.ipaddress;

    if (ip) {
      /* eslint-disable no-bitwise */
      entry.ip = `${ip >> 24 & 0xFF}.${ip >> 16 & 0xFF}.${ip >> 8 & 0xFF}.${ip & 0xFF}`;
    }

    entry.st = N.models.blogs.BlogEntry.statuses.VISIBLE;

    if (user && user.hb) {
      entry.ste = entry.st;
      entry.st  = N.models.blogs.BlogEntry.statuses.HB;
    }

    await new N.models.vbconvert.BlogTitle({
      mysql: row.blogid,
      title: row.title
    }).save();

    // "mapping" here is only needed to store original bbcode text content
    await new N.models.vbconvert.BlogTextMapping({
      blogid:     row.blogid,
      blogtextid: row.blogtextid,
      is_comment: false,
      mongo:      entry._id,
      text:       row.pagetext
    }).save();

    await entry.save();
  }

  // reset counter
  let { maxid } = (await conn.query('SELECT MAX(blogid) AS maxid FROM blog'))[0][0];

  await N.models.core.Increment.update(
    { key: 'blog_entry' },
    { $set: { value: maxid } },
    { upsert: true }
  );

  bar.terminate();
  get_user_by_hid.clear();
  get_default_usergroup.clear();
  get_parser_param_id.clear();
  conn.release();
  N.logger.info('Blog entry import finished');
};
