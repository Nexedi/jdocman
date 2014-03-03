/*jslint indent: 2, nomen: true, vars: true, browser: true */
/*global $, Logger, RSVP, dav_storage, Handlebars, jiodate, moment, i18n, jIO, Blob, complex_queries, Sanitize, renderJS */

$(document).on('mobileinit', function () {
  "use strict";

  var DEBUG = true;

  // Set up logging (as soon as possible) to console
  Logger.useDefaults();

  Logger.setLevel(DEBUG ? Logger.DEBUG : Logger.WARN);

  var ATTACHMENT_MODE = 'multiple',   // 'none', 'single', 'multiple'
    SINGLE_ATTACHMENT_NAME = 'content',
    template = {
      // precompile for speed
      'feedback-popup': Handlebars.compile($('#feedback-popup-template').text()),
      'task-list': Handlebars.compile($('#task-list-template').text()),
      'settings-form': Handlebars.compile($('#settings-form-template').text()),
      'footer': Handlebars.compile($('#footer-template').text()),
      'task-attachment-page-footer': Handlebars.compile($('#task-attachment-page-footer-template').text()),
      'task-metadata-page-footer': Handlebars.compile($('#task-metadata-page-footer-template').text()),
      'project-list': Handlebars.compile($('#project-list-template').text()),
      'task-metadata': Handlebars.compile($('#task-metadata-template').text()),
      'storage-config': Handlebars.compile($('#storage-config-template').text())
    },
    default_storage_id = 'default_storage',
    root_gadget = null,
    editor_gadget = null,
    gadget_config_set = {
      html: {
        url: 'lib/officejs/gadget/bootstrap-wysiwyg.html'
      },
      jqs: {
        url: 'lib/officejs/gadget/jqs.html'
      },
      svg: {
        url: 'lib/officejs/gadget/svgedit.html',
        beforeLoad: function () {
          // Discard the previous data, which is possibly unrelated to the current task.
          localStorage.removeItem('svgedit-default');
        }
      },
    },
    gadget_config = gadget_config_set.html,
    _jio = null,
    _jio_promise = null,
    _jio_config = null,
    _jio_config_promise = null;



  if (DEBUG) {
    switch (window.location.hash) {
    case '#attachment-none':
      ATTACHMENT_MODE = 'none';
      break;
    case '#attachment-single':
      ATTACHMENT_MODE = 'single';
      break;
    case '#attachment-multiple':
      ATTACHMENT_MODE = 'multiple';
      break;
    }
    Logger.debug('Attachment mode: ', ATTACHMENT_MODE);
  }


  /**
   * Creates a function to use for (case insensitive) accent folding.
   *
   * @param {String} map an array of (regexp, string) to do the conversion.
   * @return {Function} the folding function.
   */
  function AccentFolder(map) {
    return function accentFoldLC(s) {
      if (!s) {
        return s;
      }
      map.forEach(function (o) {
        var rep = function (match) {
          if (match.toUpperCase() === match) {
            return o[1].toUpperCase();
          }
          return o[1];
        };
        s = s.replace(o[0], rep);
      });
      return s.toLowerCase();
    };
  }


  var accentFoldLC = new AccentFolder([
      [new RegExp('[àáâãäå]', 'gi'), 'a'],
      [new RegExp('æ', 'gi'), 'ae'],
      [new RegExp('ç', 'gi'), 'c'],
      [new RegExp('[èéêë]', 'gi'), 'e'],
      [new RegExp('[ìíîï]', 'gi'), 'i'],
      [new RegExp('ñ', 'gi'), 'n'],
      [new RegExp('[òóôõö]', 'gi'), 'o'],
      [new RegExp('œ', 'gi'), 'oe'],
      [new RegExp('[ùúûü]', 'gi'), 'u'],
      [new RegExp('[ýÿ]', 'gi'), 'y']
    ]),
    //
    // Define a schema of search keys for the task queries,
    // as described in http://jio.readthedocs.org/en/latest/keys.html
    // This schema implements filtering with partial dates, titles and descriptions
    // regardless of the accents and letter case, and translated state values.
    //
    key_schema = {
      cast_lookup: {
        dateType: jiodate.JIODate
      },
      match_lookup: {
        translatedStateMatch: function (object_value, value) {
          var translated_object_value = i18n.t(object_value);
          return RSVP.resolve(accentFoldLC(translated_object_value) ===
                              accentFoldLC(value));
        }
      },
      key_set: {
        title: {
          read_from: 'title',
          cast_to: accentFoldLC
        },
        description: {
          read_from: 'description',
          cast_to: accentFoldLC
        },
        start: {
          read_from: 'start',
          cast_to: 'dateType'
        },
        stop: {
          read_from: 'stop',
          cast_to: 'dateType'
        },
        translated_state: {
          read_from: 'state',
          equal_match: 'translatedStateMatch'
        }
      }
    };



  /****************************************
   *                                      *
   * Most function definitions start here *
   *                                      *
   ****************************************/

  /**
   * Retrieve the ID of the main storage
   * to use for metadata and attachments.
   *
   * @return {String} The id of the storage
   */
  function getSelectedStorage() {
    return localStorage.getItem('jio_selected_storage');
  }


  /**
   * Change the current storage, and force
   * jioConnect to ask for a new instance.
   *
   * @param {String} val The id of the storage to use
   */
  function setSelectedStorage(val) {
    Logger.debug('Switching storage to', val);
    _jio = null;
    _jio_promise = null;
    localStorage.setItem('jio_selected_storage', val);
  }


  /**
   * If the browser supports the Application Cache, check
   * if an update is available and propose a page reload to the user.
   */
  function checkCacheUpdate() {
    var ac = window.applicationCache;
    if (!ac) {
      return;
    }
    ac.addEventListener('updateready', function () {
      if (ac.status === ac.UPDATEREADY) {
        ac.swapCache();
        if (window.confirm('An update is available. Reload now?')) {
          window.location.reload();
        }
      }
    }, false);
  }


  /**
   * Parse a fragment identifier with parameters.
   *
   * @param {String} hash The fragment string, like '#foo?bar=baz
   * @return {Object} A mapping of the parsed parameters, like {bar: 'baz'}
   */
  function parseHashParams(hash) {
    var pos = hash.indexOf('?'),
      s = pos > -1 ? hash.substr(pos + 1) : '',
      p = s ? s.split(/\&/) : [],
      l = 0,
      key_value,
      params = {};
    for (l = 0; l < p.length; l += 1) {
      key_value = p[l].split(/\=/);
      params[key_value[0]] = decodeURIComponent(key_value[1] || '') || true;
    }
    return params;
  }


  function encodeHashParams(fragment, params) {
    var parts = [], key = null;
    params = params || {};
    for (key in params) {
      if (params.hasOwnProperty(key)) {
        parts.push(key + '=' + encodeURIComponent(params[key]));
      }
    }
    return parts.length ? (fragment + '?' + parts.join('&')) : fragment;
  }


  /**
   * Immediately apply translation to all elements
   * which have a data-i18n attribute.
   */
  function applyTranslation() {
    $('[data-i18n]').i18n();
  }


  /**
   * Detect if the browser has native support for <input type="date">
   *
   * @return {Boolean} true if the browser has a datepicker, false otherwise.
   */
  function hasHTML5DatePicker() {
    var el = document.createElement('input');
    el.setAttribute('type', 'date');
    return el.type !== 'text';
  }


  /**
   * Update a <select> element's selected option,
   * then activates the jquery mobile event to refresh UI
   */
  function jqmSetSelected(element, value) {
    var $select = $(element);

    /*jslint unparam: true*/
    $select.children().each(function (i, op) {
      if (op.getAttribute('value') === value) {
        op.setAttribute('selected', 'selected');
      }
    });
    /*jslint unparam: false*/

    $select.selectmenu('refresh');
  }


  /*
   * Changes page and provide parameters within the fragment identifier.
   * The hack is to temporarily change the target url of the JQM page.
   * It will be restored during the pageshow event.
   *
   * @param {String} page the page id, including '#'.
   * @param {Object|String} params the parameters to encode, or a fragment
   * identifier which is already encoded. Optional.
   */
  function gotoPage(page, params) {
    // here '#' has double meaning: CSS selector and fragment separator
    var url = (typeof params === 'string') ? params : encodeHashParams(page, params);
    $(page).jqmData('url', url);
    $.mobile.changePage(page);
  }


  /**
   * Retrieves the text typed by the user for searching.
   *
   * @return {String} the search string
   */
  function getSearchString() {
    return $('#search-tasks').val().trim();
  }


  /**
   * Attempt to parse a string to a (possibly partial) date.
   * The returned object can be directly fed to a query if
   * the right key_schema has been provided.
   *
   * @param {String} s The string to be parsed
   * @return {Object} a JIODate instance if possible, or null
   */
  function parseJIODate(s) {
    try {
      return jiodate.JIODate(s);
    } catch (e) {
      return null;
    }
  }


  /**
   * Display a message, within a JQM modal popup.
   */
  function displayFeedback(header, message) {
    var $container = $('#feedbackPopupContainer'),
      html = template['feedback-popup']({
        message: header,
        details: message,
        button_text: 'Ok'
      });

    if ($container.length === 0) {
      $container = $('<div id="feedbackPopupContainer">');
      $(document.body).append($container);
    }

    $container.html(html).trigger('create');
    $('#feedbackPopup').popup('open');
    $('#feedbackPopup').bind({
      popupafterclose: function () {
        $('#feedbackPopup').remove();
      }
    });
  }


  /**
   * Display an error's title and message, as received by jIO methods.
   * In case of exception, shows the stack trace.
   * This function can be used as a then parameter.
   *
   *     doSomething().then(...).fail(displayError);
   */
  function displayError(error) {
    var header = error.statusText || 'Application error',
      message = error.stack ? ('<pre>' + error.stack + ' </pre>') : error.message;

    displayFeedback(header, message);
  }


  /**
   * This function must be used as a then parameter if you don't want to manage
   * errors. It changes the promise to the fulfillment channel with no fulfillment
   * value.
   *
   *     doSomething().fail(ignoreError).then(...);
   */
  function ignoreError(e) {
    Logger.error('Error ignored:', e);
    // no error propagated here
  }


  /**
   * This function must be used as a progress parameter if you don't want to
   * propagate notifications.
   *
   *     doSomething().progress(stopProgressPropagation).then(...);
   */
  function stopProgressPropagation() {
    // stop progress propagation
    throw new Error('Progress stopped');
  }


  /**
   * Creates a storage description from to a configuration object.
   */
  function storageDescription(config) {
    if (config.storage_type === 'local') {
      return {
        type: 'local',
        username: config.username,
        application_name: config.application_name
      };
    }

    if (config.storage_type === 'dav') {
      return {
        type: 'query',
        sub_storage: dav_storage.createDescription(
          config.url,
          config.auth_type,
          config.realm,
          config.username,
          config.password
        )
      };
    }
    window.alert('unsupported storage type: ' + config.storage_type);
  }


  /**
   * This function creates the global _jio_config instance bound to localStorage
   * and, if the storage is empty, inserts some hard coded configurations.
   * The returned promise will have _jio_config as fulfillment value or undefined,
   * and it will never be rejected.
   * This promise is not cancellable and sends no notifications.
   *
   * @return {Promise} The promise < _jio_config, post_error >
   */
  function jioConfigConnect() {
    if (_jio_config) {
      return RSVP.resolve(_jio_config);
    }
    if (_jio_config_promise) {
      // another call to jioConfigConnect() has been made,
      // but the promise has not resolved yet, so we return it again
      return _jio_config_promise;
    }

    var jio_config = jIO.createJIO({
      type: 'local',
      username: 'Admin',
      application_name: 'Taskman-config'
    });

    // either load configuration from local storage, or create it

    var postSomeConfIfNecessary = function (alldocs_response) {
      if (alldocs_response.data.total_rows) {
        _jio_config = jio_config;
        return _jio_config;
      }
      Logger.debug('No configuration found, populating configuration storage');

      var post_promise_list = null,
        // first of the list is the default storage
        default_config_list = [
          {
            storage_type: 'local',
            username: 'Admin',
            application_name: 'Local',
            url: '',
            realm: '',
            auth_type: '',
            password: ''
          }, {
            storage_type: 'dav',
            username: 'Admin',
            application_name: 'WebDAV',
            url: 'http://localhost/',
            realm: '',
            auth_type: 'none',
            password: ''
          }, {
            storage_type: 'local',
            application_name: 'Local 2',
            json_description: '{"type":"local","username":"Admin","application_name":"Local"}'
          }
        ];

      post_promise_list = default_config_list.map(function (config, i) {
        var metadata = {
          modified: new Date(),
          type: 'Storage Configuration'
        },
          blob = new Blob([JSON.stringify(config)], {type: 'application/json'});
        if (i === 0) {
          metadata._id = default_storage_id;
        }
        return jio_config.post(metadata).then(function (response) {
          return jio_config.putAttachment({
            _id: response.id,
            _attachment: 'config',
            _data: blob
          });
        });
      });

      return RSVP.all(post_promise_list).
        then(function () {
          Logger.debug('Configuration created.');
          _jio_config = jio_config;
          return _jio_config;
        });
    };

    _jio_config_promise = jio_config.allDocs().
      then(postSomeConfIfNecessary).
      then(null, null, stopProgressPropagation);
    return _jio_config_promise;
  }


  /**
   * This function creates the global _jio instance bound to the
   * main storage.
   * The returned promise will have _jio as fulfillment value or undefined,
   * and it will never be rejected.
   * This promise is not cancellable and sends no notifications.
   *
   * @return {Promise} The promise < _jio, post_error >
   */
  function jioConnect() {
    if (_jio) {
      return RSVP.resolve(_jio);
    }
    if (_jio_promise) {
      // another call to jioConnect() has been made,
      // but the promise has not resolved yet, so we return it again
      return _jio_promise;
    }
    _jio_promise = jioConfigConnect().
      then(function (jio_config) {
        return jio_config.getAttachment({
          _id: getSelectedStorage(),
          _attachment: 'config'
        });
      }).
      then(function (response) {
        return jIO.util.readBlobAsText(response.data);
      }).
      then(function (ev) {
        return JSON.parse(ev.target.result);
      }).
      then(function (config) {
        Logger.debug('Using storage:', config.application_name);
        var storage_description = config.json_description ? JSON.parse(config.json_description) : storageDescription(config);
        storage_description.key_schema = key_schema;
        _jio = jIO.createJIO(storage_description);
        return _jio;
      }).
      then(null, null, stopProgressPropagation);
    return _jio_promise;
  }


  /**
   * Remove all data from a storage.
   *
   * @param {Object} jio The storage to clear
   */
  function deleteStorageContent(jio) {
    return jio.allDocs().then(function (response) {
      var del_promise_list = response.data.rows.map(function (row) {
        Logger.debug('Removing: %s on storage %o', row.id, jio);
        return jio.remove({_id: row.id});
      });
      return RSVP.all(del_promise_list).then(function () {
        Logger.debug('%i object(s) have been removed from %o', del_promise_list.length, jio);
        return del_promise_list.length;
      });
    });
  }


  /**
   * Check if a project already exists.
   *
   * @param {Object} jio the storage instance to use
   * @param {String} project name of the project to look up
   * @return {Promise} A promise that resolved to true
   * if the project exists, false otherwise.
   */
  function checkProjectExists(jio, project) {
    return jio.allDocs({
      query:  {
        type: 'complex',
        operator: 'AND',
        query_list: [
          {
            type: 'simple',
            key: 'type',
            value: 'Project'
          }, {
            type: 'simple',
            key: 'project',
            operator: '=',
            value: project
          }
        ]
      }
    }).then(function (response) {
      return RSVP.resolve(response.data.total_rows >= 1);
    });
  }


  /**
   * Count the tasks with a given state.
   *
   * @param {Object} jio the storage instance to use
   * @param {String} state name of the state to look up
   * @return {Promise} A promise that resolved to the
   * number of tasks with that state.
   */
  function countStateTasks(jio, state) {
    return jio.allDocs({
      query:  {
        type: 'complex',
        operator: 'AND',
        query_list: [
          {
            type: 'simple',
            key: 'type',
            value: 'Task'
          }, {
            type: 'simple',
            key: 'state',
            operator: '=',
            value: state
          }
        ]
      }
    }).then(function (response) {
      return RSVP.resolve(response.data.total_rows);
    });
  }


  /**
   * Count the tasks within a project.
   *
   * @param {Object} jio the storage instance to use
   * @param {String} project name of the project to look up
   * @return {Promise} A promise that resolved to the
   * number of tasks in the project.
   */
  function countProjectTasks(jio, project) {
    return jio.allDocs({
      query:  {
        type: 'complex',
        operator: 'AND',
        query_list: [
          {
            type: 'simple',
            key: 'type',
            value: 'Task'
          }, {
            type: 'simple',
            key: 'project',
            operator: '=',
            value: project
          }
        ]
      }
    }).then(function (response) {
      return RSVP.resolve(response.data.total_rows);
    });
  }


  /**
   * Check if a state already exists.
   *
   * @param {Object} jio the storage instance to use
   * @param {String} state name of the state to look up
   * @return {Promise} A promise that resolved to true
   * if the state exists, false otherwise.
   */
  function checkStateExists(jio, state) {
    return jio.allDocs({
      query:  {
        type: 'complex',
        operator: 'AND',
        query_list: [
          {
            type: 'simple',
            key: 'type',
            value: 'State'
          }, {
            type: 'simple',
            key: 'state',
            operator: '=',
            value: state
          }
        ]
      }
    }).then(function (response) {
      return RSVP.resolve(response.data.total_rows >= 1);
    });
  }


  /**
   * Create a query string from the input text, if the
   * text already complies to the complex_queries grammar.
   * Basically adds a filter for the task type.
   * XXX nice to have: check grammar
   *
   * @param {Object} input_text a grammar-complying query string
   * @return {String} A query string that can be used with allDocs
   */
  function grammarQuery(search_string) {
    var query = '(type: "Task")';
    if (search_string) {
      query += ' AND ' + search_string;
    }
    return query;
  }


  /**
   * Create a query tree from the input text,
   * comparing with multiple properties and the start-stop date range.
   *
   * @param {Object} input_text a search term to be compared
   * @return {String} A query tree that can be used with allDocs
   */
  function smartQuery(search_string) {
    var query = null,
      search_date = parseJIODate(search_string),
      content_query_list = [];

    if (search_string) {
      content_query_list.push({
        type: 'simple',
        key: 'title',
        value: '%' + search_string + '%'
      });
      content_query_list.push({
        type: 'simple',
        key: 'description',
        value: '%' + search_string + '%'
      });
      content_query_list.push({
        type: 'simple',
        key: 'translated_state',
        value: search_string
      });
    }

    if (search_date) {
      Logger.debug('Search for date: %o', search_date);

      content_query_list.push({
        type: 'complex',
        operator: 'AND',
        query_list: [
          {
            type: 'simple',
            operator: '<=',
            key: 'start',
            value: search_date
          }, {
            type: 'simple',
            operator: '>=',
            key: 'stop',
            value: search_date
          }
        ]
      });
    }

    query = {
      type: 'simple',
      key: 'type',
      value: 'Task'
    };

    if (content_query_list.length) {
      query = {
        type: 'complex',
        operator: 'AND',
        query_list: [
          query,
          {
            type: 'complex',
            operator: 'OR',
            query_list: content_query_list
          }
        ]
      };
    }

    return query;
  }


  /**
   * Display (or refresh) a list of tasks in the current page,
   * performing a search if there is search input.
   * Translation is applied after rendering the template.
   *
   * @param {Object} jio The storage instance
   * @param {String} sort_by name of the metadata property to sort on
   */
  function updateTaskList(jio, sort_by) {
    var search_string = getSearchString(),
      sort_on = [[sort_by || 'start', 'ascending']],
      query_function = search_string.charAt(0) === '(' ? grammarQuery : smartQuery,
      options = {
        include_docs: true,
        wildcard_character: '%',
        sort_on: sort_on,
        query: query_function(search_string)
      };

    Logger.debug('Querying tasks with: "%s" (%o)...', search_string, options.query);

    return jio.allDocs(options).
      then(function (response) {
        Logger.debug('%i tasks found', response.data.total_rows);
        $('#task-list-container').
          html(template['task-list']({
            rows: response.data.rows
          })).
          trigger('create');
        applyTranslation();
      });
  }


  /**
   * Retrieve all the storage metadata and configuration attachments.
   *
   * @param {Object} jio_config The configuration storage
   * @return {Promise} A Promise which resolves to a list
   * of objects {doc: {...}, config: {...}}
   */
  function storageConfigList(jio_config) {
    return jio_config.allDocs({include_docs: true}).
      then(function (alldocs) {
        var attachment_promise_list = alldocs.data.rows.map(function (row) {
          var prom = jio_config.
            getAttachment({_id: row.id, _attachment: 'config'}).
            then(function (response) {
              return jIO.util.readBlobAsText(response.data);
            }).
            then(function (ev) {
              return {
                id: row.id,
                doc: row.doc,
                config: JSON.parse(ev.target.result)
              };
            });
          return prom;
        });
        return RSVP.all(attachment_promise_list);
      });
  }


  /**
   * Update the settings form to edit project/state list.
   */
  function updateSettingsForm() {
    var _storage_list = null,
      error_message = null;

    return jioConfigConnect().
      then(storageConfigList).
      then(function (storage_list) {
        // store the configuration list in a closure var
        _storage_list = storage_list;
      }).
      then(jioConnect).
      // keep going even if we could not connect to the main storage
      fail(ignoreError).
      always(function (jio) {
        var project_opt = {include_docs: true, sort_on: [['project', 'ascending']], query: '(type:"Project")'},
          state_opt = {include_docs: true, sort_on: [['state', 'ascending']], query: '(type:"State")'};

        if (jio) {
          return RSVP.all([
            jio.allDocs(project_opt),
            jio.allDocs(state_opt),
          ]);
        }
      }).
      // keep going even if we could not retrieve the state/project lists
      fail(function (e) {
        error_message = e.message; // enough for both jio messages and exceptions
      }).
      always(function (response_list) {
        var project_list = response_list ? response_list[0].data.rows : null,
          state_list = response_list ? response_list[1].data.rows : null;

        $('#settings-form-container').
          html(template['settings-form']({
            connection_ok: project_list !== null && state_list !== null,
            error_message: error_message,
            storage_list: _storage_list,
            project_list: project_list,
            state_list: state_list
          })).
          trigger('create');

        jqmSetSelected('#translate', i18n.lng());
        jqmSetSelected('#storage-select', getSelectedStorage());
        applyTranslation();
      }).fail(displayError);
  }


  /**
   * Retrieve a single storage's configuration,
   * or provide the default value for a configuration object.
   *
   * @param {Object} jio_config The configuration storage
   * @param {String} id The id of the configuration to retrieve (may be null)
   * @return {Promise} A Promise which resolves to the configuration object.
   */
  function storageConfig(jio_config, id) {
    if (!id) {
      return RSVP.resolve({
        storage_type: 'local'
      });
    }

    return jio_config.get({_id: id}).
      then(function (response) {
        return jio_config.
          getAttachment({_id: response.id, _attachment: 'config'}).
          then(function (response) {
            return jIO.util.readBlobAsText(response.data);
          }).
          then(function (ev) {
            return JSON.parse(ev.target.result);
          });
      });
  }


  /**
   * If the current page has a .footer-container element,
   * update it and set the current tab.
   */
  function updateFooter() {
    var $page = $.mobile.activePage,
      page_id = $page.attr('id'),
      $footer_container = $page.find('.footer-container');

    if ($footer_container.length === 0) {
      return;
    }

    // We can't inspect the page to see if there's an iframe, since
    // the form is generated with a template and is not on the DOM yet.
    // Therefore we hardcode the id of the page and directly check it.
    var footer_template = template[page_id + '-footer'] || template.footer;

    $footer_container.
      html(footer_template({
        args: parseHashParams(window.location.hash)
      })).
      trigger('create');

    // activate the tab related to the current page (if any)
    $footer_container.find('a[href=#' + page_id + ']').addClass('ui-btn-active');

    applyTranslation();
  }


  /**
   * Update the metadata form to edit project/state list.
   * Works either in a full page or a popup.
   */
  function updateMetadataForm() {
    var task_id = parseHashParams(window.location.hash).task_id;

    jioConnect().then(function (jio) {
      var project_opt = {include_docs: true, sort_on: [['project', 'ascending']], query: '(type:"Project")'},
        project_promise = jio.allDocs(project_opt),
        task_promise = null,
        state_opt = {include_docs: true, sort_on: [['state', 'ascending']], query: '(type:"State")'},
        state_promise = jio.allDocs(state_opt),
        dateinput_type = hasHTML5DatePicker() ? 'date' : 'text';

      if (task_id) {
        task_promise = jio.get({_id: task_id});
      } else {
        task_promise = new RSVP.Promise(function (resolve) {
          resolve({
            data: {
              title: 'New task',
              start: moment().format('YYYY-MM-DD')
            }
          });
        });
      }

      return RSVP.all([task_promise, project_promise, state_promise]).
        then(function (response_list) {
          var task_resp = response_list[0],
            project_list = response_list[1].data.rows,
            state_list = response_list[2].data.rows,
            attachments = task_resp.data._attachments || [],
            page = $.mobile.activePage;

          page.find('.task-metadata-container').
            html(template['task-metadata']({
              task: task_resp.data,
              task_id: task_resp.id,
              attachments: attachments,
              project_list: project_list,
              state_list: state_list,
              dateinput_type: dateinput_type
            })).
            trigger('create');

          jqmSetSelected(page.find('[name=project]'), task_resp.data.project);
          jqmSetSelected(page.find('[name=state]'), task_resp.data.state);
          applyTranslation();
        });
    }).fail(displayError);
  }


  function saveMetadata() {
    return jioConnect().then(function (jio) {
      var task_id = parseHashParams(window.location.hash).task_id,
        page = $.mobile.activePage,
        title = page.find('[name=title]').val(),
        start = page.find('[name=start]').val(),
        stop = page.find('[name=stop]').val(),
        project = page.find('[name=project]').val(),
        state = page.find('[name=state]').val(),
        description = $('[name=description]').val(),
        metadata = {},
        update_prom = null;

      // XXX validate input

      metadata = {
        type: 'Task',
        title: title,
        start: start,
        stop: stop,
        project: project,
        state: state,
        description: description,
        modified: new Date()
      };

      if (task_id) {
        metadata._id = task_id;
        update_prom = jio.put(metadata);
      } else {
        update_prom = jio.post(metadata);
      }

      return update_prom.
        then(function (response) {
          Logger.debug('Updated task %o:', response.id);
          Logger.debug('  status %s (%s)', response.status, response.statusText);
          return RSVP.resolve(response.id);
        });
    }).fail(displayError);
  }






  /***********************************
   *                                 *
   * Handlebars helpers registration *
   *                                 *
   ***********************************/

  Handlebars.registerPartial('task-link', $('#task-link-partial').text());

  Handlebars.registerHelper('SINGLE_ATTACHMENT_NAME', function () {
    return SINGLE_ATTACHMENT_NAME;
  });

  Handlebars.registerHelper('ATTACHMENT_MODE_SINGLE', function (options) {
    if (ATTACHMENT_MODE === 'single') {
      return options.fn(this);
    }
    return options.inverse(this);
  });

  Handlebars.registerHelper('ATTACHMENT_MODE_MULTIPLE', function (options) {
    if (ATTACHMENT_MODE === 'multiple') {
      return options.fn(this);
    }
    return options.inverse(this);
  });


  /**
   * Clean up HTML before display for security reasons
   * (see https://github.com/gbirke/Sanitize.js)
   * Also, truncates the resulting string if it's too long.
   * This may leave bad formatting in 'relaxed' mode,
   * but we are using the strictest mode, which only
   * preserves the text content.
   *
   * @param {String} html The insecure string to sanitize.
   * @param {String} maxsize The length to trim the string at.
   * @return {String} The safe (will not be escaped) string to render in HTML.
   */
  Handlebars.registerHelper('sanitize', function (html, maxsize) {
    // The Sanitize module only works on DOM nodes, so we create one from the string...
    var node = $('<div>' + html + '</div>'),
      s = new Sanitize(),
      clean_fragment = s.clean_node(node[0]),
      // ...take the resulting fragment...
      tmpdiv = document.createElement('div'),
      text = '';

    // ...and wrap the fragment around a node...
    tmpdiv.appendChild(clean_fragment);
    // ...only to access its innerHTML property.
    // It would be simpler if Sanitize took a string.

    text = tmpdiv.innerHTML;

    if (maxsize && text.length > maxsize) {
      // truncate string to word boundary
      text = text.substr(0, maxsize - 1);
      if (text.indexOf(' ') !== -1) {
        // single huge word, cut it
        text = text.substr(0, text.lastIndexOf(' '));
      }
      text = text + '&hellip;';
    }

    return new Handlebars.SafeString(text);
  });


  /**
   * Display date strings or objects as yyyy-mm-dd - see https://xkcd.com/1179/
   * (takes timezone into account)
   *
   * @param {String} date The date string (or Date object) to display.
   * @return {String} The safe (will not be escaped) string to render in HTML.
   * Escaped or not, it doesn't make a real difference here.
   */
  Handlebars.registerHelper('asYMD', function (date) {
    if (date) {
      return new Handlebars.SafeString(moment(date).format('YYYY-MM-DD'));
    }
    return '';
  });


  /**
   * Make translations accessible from within Handlebars templates
   */
  Handlebars.registerHelper('t', function (i18n_key) {
    return i18n_key ? new Handlebars.SafeString(i18n.t(i18n_key)) : '';
  });


  /**
   * Make translations accessible from within Handlebars templates
   */
  Handlebars.registerHelper('encode', function (text) {
    return window.encodeURIComponent(text);
  });


  /**
   * Add value comparisions, see also
   * http://github.com/assemble/handlebars-helpers/blob/master/lib/helpers/helpers-comparisons.js
   * The operator must be quoted:
   *
   * {{#ifCond v1 '===' v2}}
   * ...
   * {{/ifCond}}
   */
  Handlebars.registerHelper('ifCond', function (v1, operator, v2, options) {
    switch (operator) {
    case '!==':
      return (v1 !== v2) ? options.fn(this) : options.inverse(this);
    case '===':
      return (v1 === v2) ? options.fn(this) : options.inverse(this);
    case '<':
      return (v1 < v2) ? options.fn(this) : options.inverse(this);
    case '<=':
      return (v1 <= v2) ? options.fn(this) : options.inverse(this);
    case '>':
      return (v1 > v2) ? options.fn(this) : options.inverse(this);
    case '>=':
      return (v1 >= v2) ? options.fn(this) : options.inverse(this);
    default:
      return options.inverse(this);
    }
  });




  /********************************
   *                              *
   * UI event handlers start here *
   *                              *
   ********************************/

  $(document).on('pageshow', function () {
    var $page = $.mobile.activePage;

    // Restore the url of the page we're showing.
    // This hack is needed to support hash parameters until JQM v1.5.
    // For more information, see
    // https://github.com/jquery/jquery-mobile/issues/2859
    // https://github.com/jquery/jquery-mobile/issues/6965
    $page.jqmData('url', '#' + $page.attr('id'));

    // Update the navigation footer
    updateFooter();
  });


  /**
   * Apply a language change upon selection from the menu.
   * This will store the selected language in the 'i18next'
   * session cookie.
   */
  $(document).on('change', '#translate', function () {
    var current_language = $(this).val();
    $.i18n.setLng(current_language, applyTranslation);
  });


  $(document).on('pagebeforeshow', '#settings-page', function () {
    updateSettingsForm();
  });


  /**
   * Prepare the #project-list-page before displaying.
   * This queries the storage for a list of the projects and tasks,
   * then provides them as parameters to Handlebars.
   * Translation is applied after rendering the template.
   */
  $(document).on('pagebeforeshow', '#project-list-page', function () {
    jioConnect().then(function (jio) {
      var options = {
        include_docs: true,
        query: '(type:"Project") OR (type:"Task")',
        sort_on: [['project', 'ascending']]
      }, task_map = {};

      return jio.allDocs(options).
        then(function (response) {
          var i = 0,
            rows = response.data.rows;

          // Handlebars has very limited support for traversing data,
          // so we have to group/count everything in advance.

          for (i = 0; i < rows.length; i += 1) {
            if (rows[i].doc.type === 'Project') {
              task_map[rows[i].doc.project] = {tasks: [], task_count: 0};
            }
          }

          for (i = 0; i < rows.length; i += 1) {
            if (rows[i].doc.type === 'Task') {
              task_map[rows[i].doc.project] = task_map[rows[i].doc.project] || {tasks: [], task_count: 0};
              task_map[rows[i].doc.project].tasks.push(rows[i]);
              task_map[rows[i].doc.project].task_count += 1;
            }
          }

          $('#project-list-container').
            html(template['project-list']({
              project_count: rows.length,
              task_map: task_map
            })).
            trigger('create'); // notify jqm of the changes we made
          applyTranslation();
        });
    }).fail(displayError);
  });


  /**
   * Apply a sort order change to the task list, upon selection from the menu.
   */
  $(document).on('change', '#task-sortby', function () {
    var sort_by = $(this).val();
    jioConnect().then(function (jio) {
      return updateTaskList(jio, sort_by);
    }).fail(displayError);
  });


  /**
   * Initial rendering of the 'task list' page.
   */
  $(document).on('pagebeforeshow', '#task-list-page', function () {
    jioConnect().then(function (jio) {
      // attempt to fix cosmetic issue with a select menu in the header
      $('#task-sortby-button').addClass('ui-btn-left');
      return updateTaskList(jio);
    }).fail(displayError);
  });


  var _input_timer = null;

  /**
   * Perform a search and update the task list.
   * A timer is used to avoid querying for each character.
   */
  $(document).on('input', '#search-tasks', function () {
    var search_string = getSearchString();

    // Grammar vs Smart queries will be discriminated by parentheses.
    // To avoid flooding the server, a beginning parens requires an
    // ending parens. Also, all queries are delayed by 500 ms in case
    // of further input.

    if (search_string.charAt(0) === '(' &&
        search_string.charAt(search_string.length - 1) !== ')') {
      return;
    }

    jioConnect().then(function (jio) {
      if (_input_timer) {
        window.clearTimeout(_input_timer);
        _input_timer = null;
      }
      _input_timer = window.setTimeout(function () {
        updateTaskList(jio); // XXX errors from this promise are not propagated
                             // and would have to be handled separately.
        _input_timer = 0;
      }, 500);
    }).fail(displayError);
  });


  /**
   * Redirects to the details page for a task, when a task is
   * clicked in the list.
   * Since we cannot use query parameters (they would not work
   * with the appcache) we temporarily change the url of
   * the target page. It will be restored during the pageshow event.
   */
  $(document).on('click', '.task-metadata-link', function () {
    gotoPage('#task-metadata-page', this.hash);
  });


  /**
   * Display the form to edit a single task's details,
   * or to create a new task.
   * Translation is applied after rendering the template.
   */
  $(document).on('pagebeforeshow', '#task-metadata-page', function () {
    updateMetadataForm();
  });


  $(document).on('click', '#task-metadata-popup-trigger', function () {
    updateMetadataForm();
    $('#task-metadata-popup').popup('open');
  });


  $(document).on('click', '#metadata-save', function () {
    saveMetadata().
      then(function () {
        $('#task-metadata-popup').popup('close');
      });
  });


  /**
   * Apply changes to the edited task, or create
   * a new task in the storage.
   */
  $(document).on('click', '#task-save', function () {
    saveMetadata().
      then(function (task_id) {
        if (ATTACHMENT_MODE === 'single') {
          gotoPage('#task-attachment-page',
                   { task_id: task_id,
                     attachment_name: SINGLE_ATTACHMENT_NAME});
          return;
        }
        parent.history.back();
      });
  });


  /**
   * Delete the currently open task from the storage.
   */
  $(document).on('click', '#task-delete', function () {
    var task_id = parseHashParams(window.location.hash).task_id;

    jioConnect().then(function (jio) {
      return jio.remove({_id: task_id});
    }).then(function (response) {
      Logger.debug('Deleted task %o:', response.id);
      Logger.debug('  status %s', response.status);
      parent.history.back();
    }).fail(displayError);
  });


  /**
   * Delete the currently open attachment.
   */
  $(document).on('click', '#attachment-delete', function () {
    var args = parseHashParams(window.location.hash),
      task_id = args.task_id,
      attachment_name = args.attachment_name;

    jioConnect().then(function (jio) {
      return jio.removeAttachment({_id: task_id,
                                   _attachment: attachment_name});
    }).then(function (response) {
      Logger.debug('Deleted attachment %s/%s:', response.id, response.attachment);
      Logger.debug('  status %s', response.status);
      parent.history.back();
    }).fail(function (response) {
      if (response.status === 404) {
        parent.history.back();
        return;
      }
      throw response;
    }).fail(displayError);
  });


  /**
   * Redirects to the document edit page (for new attachments).
   */
  $(document).on('click', '#task-add-attachment', function () {
    var task_id = parseHashParams(window.location.hash).task_id,
      attachment_name = window.prompt('Document name?') || '';

    attachment_name = attachment_name.trim();

    if (!attachment_name) {
      return;
    }

    // XXX check for duplicate names

    gotoPage('#task-attachment-page',
             { task_id: task_id,
               attachment_name: attachment_name});
  });


  /**
   * Redirects to the document edit page (for existing attachments).
   */
  $(document).on('click', '.task-edit-attachment-link', function () {
    gotoPage('#task-attachment-page', this.hash);
  });


  $(document).on('pagebeforeshow', '#task-attachment-page', function () {
    var args = parseHashParams(window.location.hash),
      task_id = args.task_id,
      attachment_name = args.attachment_name;

    editor_gadget = null;

    if (gadget_config.beforeLoad) {
      gadget_config.beforeLoad();
    }
    jioConnect().
      then(function (jio) {
        return jio.getAttachment({
          _id: task_id,
          _attachment: attachment_name
        });
      }).
      fail(function (response) {
        if (response.status === 404) {
          // attachment does not exist, no content to read
          return null;
        }
      }).
      then(function (response) {
        // XXX hack
        if (response === null) {
          return null;
        }
        return jIO.util.readBlobAsText(response.data).
          then(function (ev) {
            return ev.target.result;
          });
      }).
      then(function (attachment_content) {
        return root_gadget.declareGadget(gadget_config.url,
                                         { sandbox: 'iframe',
                                           element: document.getElementById('attachment')
                                         }).
          then(function (gadget) {
            editor_gadget = gadget;
            if (attachment_content) {
              return gadget.setContent(attachment_content);
            }
          });
      }).
      fail(displayError);
  });


  $(document).on('click', '#attachment-save', function () {
    var args = parseHashParams(window.location.hash),
      task_id = args.task_id,
      attachment_name = args.attachment_name;

    editor_gadget.getContent().
      then(function (attachment_content) {
        var attachment = {
          _id: task_id,
          _attachment: attachment_name,
          _data: new Blob([attachment_content], {type: 'application/octet-stream'})
        };
        return jioConnect().
          then(function (jio) {
            return jio.putAttachment(attachment);
          }).then(function () {
            parent.history.back();
          });
      }).
      fail(displayError);
  });


  $(document).on('pagebeforehide', '#task-attachment-page', function () {
    $('#attachment iframe').remove();
  });


  /**
   * When a storage is selected, force the next jioConnect() call
   * to use its configuration.
   */
  $(document).on('change', '#storage-select', function () {
    setSelectedStorage($(this).val());
    updateSettingsForm();
  });


  /**
   * Redirects to the details page for the selected storage.
   * Since we cannot pass the task id argument as a query
   * parameter (does not work with the appcache) we store it
   * in a closure variable.
   */
  $(document).on('click', '#storage-config', function () {
    var storage_id = $('#storage-select').val();
    gotoPage('#storage-config-page', {storage_id: storage_id});
  });


  /**
   * Display the form to edit a single storage's details,
   * or to create a new storage.
   * Translation is applied after rendering the template.
   */
  $(document).on('pagebeforeshow', '#storage-config-page', function () {
    var storage_id = parseHashParams(window.location.hash).storage_id;
    jioConfigConnect().then(function (jio_config) {
      return storageConfig(jio_config, storage_id).
        then(function (config) {
          $('#storage-config-container').
            html(template['storage-config']({
              id: storage_id,
              config: config,
              default_storage_id: default_storage_id
            })).
            trigger('create');
          applyTranslation();
        });
    }).fail(displayError);
  });


  /**
   * Apply changes to the edited storage configuration,
   * or create a new one.
   */
  $(document).on('click', '#storage-save', function () {
    jioConfigConnect().then(function (jio_config) {
      var id = $('#storage-id').val(),
        page = $.mobile.activePage,
        application_name = page.find('[name=application_name]').val(),
        storage_type = page.find('[name=storage_type]').val(),
        url = page.find('[name=storage_url]').val(),
        auth_type = page.find('[name=auth_type]').val(),
        realm = page.find('[name=realm]').val(),
        username = page.find('[name=username]').val(),
        password = page.find('[name=password]').val(),
        // something like
        // {"type":"local","username":"Admin","application_name":"Local"}
        json_description = page.find('[name=json_description]').val(),
        config = null,
        metadata = null,
        update_prom = null;

      // XXX validate input

      config = {
        application_name: application_name,
        storage_type: storage_type,
        url: url,
        auth_type: auth_type,
        realm: realm,
        username: username,
        password: password,
        json_description: json_description
      };

      metadata = {
        modified: new Date(),
        type: 'Storage Configuration',
        config: config
      };

      if (id) {
        metadata._id = id;
        update_prom = jio_config.put(metadata);
      } else {
        update_prom = jio_config.post(metadata);
      }

      return update_prom.
        then(function (response) {
          var attachment = {
            _id: response.id,
            _attachment: 'config',
            _data: new Blob([JSON.stringify(config)], {type: 'application/json'})
          };
          return jio_config.putAttachment(attachment);
        }).
        then(function (response) {
          Logger.debug('Updated storage %s', response.id);
          Logger.debug('  status %s (%s)', response.status, response.statusText);
          setSelectedStorage(response.id);
          gotoPage('#settings-page');
        });
    }).fail(displayError);
  });


  /**
   * Delete the currently open storage configuration.
   * Does not actually touch the storage's content, and resets
   * the selected storage to the default one.
   */
  $(document).on('click', '#storage-delete', function () {
    jioConfigConnect().then(function (jio_config) {
      var id = $('#storage-id').val();

      return jio_config.remove({_id: id}).
        then(function (response) {
          Logger.debug('Deleted storage %o:', response.id);
          Logger.debug('  status %s', response.status);
          setSelectedStorage(default_storage_id);
          gotoPage('#settings-page');
        });
    }).fail(displayError);
  });


  /**
   * Export the content of the current storage for backup purposes.
   */
  $(document).on('pagebeforeshow', '#storage-export-page', function () {
    var $export_container = $('#storage-export-json-container'),
      // collect evertything here as {'metadata': [...], 'attachment_list': [...]}
      archive = {},
      j = null; // jio connection

    // clear now, we might need to display an error
    $export_container.empty();

    jioConnect().then(function (jio) {
      j = jio;
      return j.allDocs({include_docs: true});
    }).then(function (response) {
      var attachment_promise_list = [];

      archive.metadata_list = response.data.rows;
      archive.attachment_list = [];

      archive.metadata_list.forEach(function (row) {
        var attachments = row.doc._attachments || {},
          attachment_name = '';
        for (attachment_name in attachments) {
          if (attachments.hasOwnProperty(attachment_name)) {
            archive.attachment_list.push({
              id: row.id,
              attachment_name: attachment_name
            });
            attachment_promise_list.push(
              j.getAttachment({
                _id: row.id,
                _attachment: attachment_name
              })
            );
          }
        }
      });
      return RSVP.all(attachment_promise_list);
    }).then(function (attachment_resp) {
      return RSVP.all(attachment_resp.map(function (response) {
        return jIO.util.readBlobAsBinaryString(response.data);
      }));
    }).then(function (attachment_content_resp) {
      attachment_content_resp.forEach(function (ev, idx) {
        // encode in base64
        archive.attachment_list[idx].b64content = window.btoa(ev.target.result);
      });

      var $textarea = $('<textarea id="storage-export-json">'),
        json = JSON.stringify(archive, null, 2);

      $export_container.
        append('<h3>Storage data</h3>').
        append($textarea);

      $textarea.
        // Set the height overriding the value set by JQM
        attr('rows', 6).
        css('height', 'inherit').
        val(json);

      var URL = window.webkitURL || window.URL,
        $link = $('<a data-role="button">Download</a>'),
        blob = new Blob([json], {type: 'application/json'});

      $link.
        attr('href', URL.createObjectURL(blob)).
        attr('download', 'storage.json');

      $export_container.
        append($link).
        trigger('create');

    }).fail(function (e) {
      $export_container.
        append('<h3>Could not export storage</h3>');
      displayError(e);
    });
  });


  /**
   * Page to import a previously exported content into the current storage.
   */
  $(document).on('pagebeforeshow', '#storage-import-page', function () {
    var $textarea = $('#storage-import-json');
    $textarea.
      // Set the height overriding the value set by JQM
      attr('rows', 6).
      css('height', 'inherit').
      val('');
  });


  /**
   * Insert test data into textarea
   */
  $(document).on('click', '#storage-import-test', function () {
    var $textarea = $('#storage-import-json');
    jIO.util.ajax({
      // XXX if 404, display the URL in dialog
      type: 'GET',
      url: 'data/test_data.json'
    }).then(function (ev) {
      $textarea.val(ev.target.responseText);
      displayFeedback('Storage import', 'Test data has been loaded. Click Import to insert it into the storage.');
    });
  });


  /**
   * Clear the content of the current storage.
   */
  $(document).on('click', '#storage-clear', function () {
    if (!window.confirm("Are you sure you want to remove the content of the storage?")) {
      return;
    }
    jioConnect().
      then(function (jio) {
        Logger.info('Clearing object storage.');
        return deleteStorageContent(jio);
      }).
      then(function (object_count) {
        displayFeedback('Storage cleanup', object_count + ' objects have been removed.');
      }).
      fail(displayError);
  });


  /**
   * Copy content from an uploaded file into the import textarea.
   */
  $(document).on('change', '#storage-import-upload', function () {
    var $input = $(this),
      file = $input[0].files[0];

    return jIO.util.readBlobAsText(file).
      then(function (ev) {
        var content = ev.target.result;
        JSON.parse(content);
        $('#storage-import-json').val(content);
      }).fail(function (e) {
        $input.val('');
        displayError({
          statusText: 'File upload error - ' + file.name,
          message: 'Cannot parse JSON data: ' + e.message
        });
      });
  });


  /**
   * Import a previously exported content into the current storage.
   */
  $(document).on('click', '#storage-import', function () {
    var object_count = 0;

    jioConnect().then(function (jio) {
      var text = $('#storage-import-json').val();

      if (!text.trim()) {
        displayError({
          statusText: 'Storage import error',
          message: 'Empty input'
        });
      }

      var archive = null;

      try {
        archive = JSON.parse(text);
      } catch (e) {
        displayError({
          statusText: 'Storage import error',
          message: 'Cannot parse JSON data: ' + e.message
        });
        return;
      }

      // XXX should clear the storage first?

      var ins_promise_list = [];

      archive.metadata_list.forEach(function (obj) {
        ins_promise_list.push(jio.put(obj.doc).
          then(function () {
            object_count += 1;
          }));
        // XXX collect and display list of errors?
      });

      archive.attachment_list.forEach(function (obj) {
        var content = window.atob(obj.b64content),
          promise = jio.putAttachment({
            _id: obj.id,
            _attachment: obj.attachment_name,
            _data: new Blob([content], {type: 'application/octet-stream'})
          });
        ins_promise_list.push(promise.
          then(function () {
            object_count += 1;
          }));
      });

      return RSVP.all(ins_promise_list);
    }).then(function () {
      displayFeedback('Storage import', object_count + ' objects have been imported.');
    }).fail(displayError);
  });


  /**
   * Delete a state. It must have no tasks.
   */
  $(document).on('click', '#settings-del-state', function () {
    jioConnect().then(function (jio) {
      var $selected = $('input:radio:checked[name=state-radio]'),
        state = $selected.data('jio-state'),
        state_id = $selected.data('jio-id');

      return countStateTasks(jio, state).
        then(function (task_count) {
          if (task_count) {
            return RSVP.reject({
              statusText: 'Cannot remove state',
              message: task_count + ' tasks are in state "' + state + '"'
            });
          }
          return jio.remove({_id: state_id});
        }).then(function () {
          Logger.debug('State %s has been removed', state);
          return updateSettingsForm();
        });

    }).fail(displayError);
  });


  /**
   * Create a new state. Its name must be unique.
   */
  $(document).on('click', '#settings-add-state', function () {
    jioConnect().then(function (jio) {
      var state = window.prompt('State name?') || '';

      state = state.trim();

      if (!state) {
        return;
      }

      state = state.charAt(0).toUpperCase() + state.slice(1);

      return checkStateExists(jio, state).
        then(function (state_exists) {
          var doc = {
            type: 'State',
            state: state,
            modified: new Date()
          };

          if (state_exists) {
            return RSVP.reject({
              statusText: 'Cannot add state',
              message: 'State "' + state + '" already exists'
            });
          }

          return jio.post(doc).
            then(function (response) {
              Logger.debug('Added state: %o', response.id);
              Logger.debug('  status %s (%s)', response.status, response.statusText);
              return updateSettingsForm();
            });
        });
    }).fail(displayError);
  });


  /**
   * Delete a project. It must have no tasks.
   */
  $(document).on('click', '#settings-del-project', function () {
    jioConnect().then(function (jio) {
      var $selected = $('input:radio:checked[name=project-radio]'),
        project = $selected.data('jio-project'),
        project_id = $selected.data('jio-id');

      // query tasks by project name, but query projects by id
      return countProjectTasks(jio, project).
        then(function (task_count) {
          if (task_count) {
            return RSVP.reject({
              statusText: 'Cannot remove project "' + project + '"',
              message: 'The project contains ' + task_count + ' tasks.'
            });
          }
          return jio.remove({_id: project_id});
        }).then(function () {
          Logger.debug('Project %s has been removed', project);
          return updateSettingsForm();
        });

    }).fail(displayError);
  });


  /**
   * Create a new project. Its name must be unique.
   */
  $(document).on('click', '#settings-add-project', function () {
    jioConnect().then(function (jio) {
      var project = window.prompt('Project name?') || '';

      project = project.trim();

      if (!project) {
        return;
      }

      project = project.charAt(0).toUpperCase() + project.slice(1);

      return checkProjectExists(jio, project).
        then(function (project_exists) {
          var doc = {
            type: 'Project',
            project: project,
            modified: new Date()
          };

          if (project_exists) {
            return RSVP.reject({
              statusText: 'Cannot add project',
              message: 'Project "' + project + '" already exists'
            });
          }

          return jio.post(doc).
            then(function (response) {
              Logger.debug('Added project: %o', response.id);
              Logger.debug('  status %s (%s)', response.status, response.statusText);
              return updateSettingsForm();
            });
        });
    }).fail(displayError);
  });



  /***************************
   *                         *
   * Application starts here *
   *                         *
   ***************************/

  if (!getSelectedStorage()) {
    setSelectedStorage(default_storage_id);
  }

  // avoid FOUC (http://en.wikipedia.org/wiki/Flash_of_unstyled_content)
  $('.initHandler').removeClass('initHandler');

  $.mobile.selectmenu.prototype.options.nativeMenu = false;
  $.mobile.defaultPageTransition = 'none';

  if (!hasHTML5DatePicker()) {
    $.datepicker.setDefaults({dateFormat: 'yy-mm-dd'});
  }

  /**
   * Set up the translations for i18next.
   * This might trigger a 404 for an unsupported locale
   * before falling back, i.e. en-US -> en
   * Also applies translations to the current page as soon
   * as the data is ready.
   * For the options, see http://i18next.com/pages/doc_init.html
   */
  $.i18n.init({
    detectLngQS: 'lang',
    fallbackLng: 'en',
    ns: 'translation',
    resGetPath: 'i18n/__lng__/__ns__.json',
    preload: ['en', 'fr', 'zh']
  }, applyTranslation);

  renderJS(window).ready(function (gadget) {
    root_gadget = gadget;
  });

  checkCacheUpdate();

});

