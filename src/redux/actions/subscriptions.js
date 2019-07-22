// @flow
import type { GetState } from 'types/redux';
import type {
  Dispatch as ReduxDispatch,
  SubscriptionState,
  Subscription,
  SubscriptionNotificationType,
  ViewMode,
  UnreadSubscription,
} from 'types/subscription';
import { PAGE_SIZE } from 'constants/claim';
import { doClaimRewardType } from 'redux/actions/rewards';
import { selectSubscriptions, selectUnreadByChannel } from 'redux/selectors/subscriptions';
import { Lbry, buildURI, parseURI, doResolveUris, doPurchaseUri } from 'lbry-redux';
import * as ACTIONS from 'constants/action_types';
import * as NOTIFICATION_TYPES from 'constants/subscriptions';
import Lbryio from 'lbryio';
import rewards from 'rewards';

const CHECK_SUBSCRIPTIONS_INTERVAL = 15 * 60 * 1000;
const SUBSCRIPTION_DOWNLOAD_LIMIT = 1;

export const doSetViewMode = (viewMode: ViewMode) => (dispatch: ReduxDispatch) =>
  dispatch({
    type: ACTIONS.SET_VIEW_MODE,
    data: viewMode,
  });

export const setSubscriptionLatest = (subscription: Subscription, uri: string) => (
  dispatch: ReduxDispatch
) =>
  dispatch({
    type: ACTIONS.SET_SUBSCRIPTION_LATEST,
    data: {
      subscription,
      uri,
    },
  });

// Populate a channels unread subscriptions or update the type
export const doUpdateUnreadSubscriptions = (
  channelUri: string,
  uris: ?Array<string>,
  type: ?SubscriptionNotificationType
) => (dispatch: ReduxDispatch, getState: GetState) => {
  const state = getState();
  const unreadByChannel = selectUnreadByChannel(state);
  const currentUnreadForChannel: UnreadSubscription = unreadByChannel[channelUri];

  let newUris: Array = [];
  let newType: string = null;

  if (!currentUnreadForChannel) {
    newUris = uris;
    newType = type;
  } else {
    if (uris) {
      // If a channel currently has no unread uris, just add them all
      if (!currentUnreadForChannel.uris || !currentUnreadForChannel.uris.length) {
        newUris = uris;
      } else {
        // They already have unreads and now there are new ones
        // Add the new ones to the beginning of the list
        // Make sure there are no duplicates
        const currentUnreadUris = currentUnreadForChannel.uris;
        newUris = uris.filter(uri => !currentUnreadUris.includes(uri)).concat(currentUnreadUris);
      }
    } else {
      newUris = currentUnreadForChannel.uris;
    }

    newType = type || currentUnreadForChannel.type;
  }

  dispatch({
    type: ACTIONS.UPDATE_SUBSCRIPTION_UNREADS,
    data: {
      channel: channelUri,
      uris: newUris,
      type: newType,
    },
  });
};

// Remove multiple files (or all) from a channels unread subscriptions
export const doRemoveUnreadSubscriptions = (channelUri: ?string, readUris: ?Array<string>) => (
  dispatch: ReduxDispatch,
  getState: GetState
) => {
  const state = getState();
  const unreadByChannel = selectUnreadByChannel(state);

  // If no channel is passed in, remove all unread subscriptions from all channels
  if (!channelUri) {
    return dispatch({
      type: ACTIONS.REMOVE_SUBSCRIPTION_UNREADS,
      data: { channel: null },
    });
  }

  const currentChannelUnread = unreadByChannel[channelUri];
  if (!currentChannelUnread || !currentChannelUnread.uris) {
    // Channel passed in doesn't have any unreads
    return null;
  }

  // For each uri passed in, remove it from the list of unread uris
  // If no uris are passed in, remove them all
  let newUris;
  if (readUris) {
    const urisToRemoveMap = readUris.reduce(
      (acc, val) => ({
        ...acc,
        [val]: true,
      }),
      {}
    );

    const filteredUris = currentChannelUnread.uris.filter(uri => !urisToRemoveMap[uri]);
    newUris = filteredUris.length ? filteredUris : null;
  } else {
    newUris = null;
  }

  return dispatch({
    type: ACTIONS.REMOVE_SUBSCRIPTION_UNREADS,
    data: {
      channel: channelUri,
      uris: newUris,
    },
  });
};

// Remove a single file from a channels unread subscriptions
export const doRemoveUnreadSubscription = (channelUri: string, readUri: string) => (
  dispatch: ReduxDispatch
) => {
  dispatch(doRemoveUnreadSubscriptions(channelUri, [readUri]));
};

export const doCheckSubscription = (subscriptionUri: string, shouldNotify?: boolean) => (
  dispatch: ReduxDispatch,
  getState: GetState
) => {
  // no dispatching FETCH_CHANNEL_CLAIMS_STARTED; causes loading issues on <SubscriptionsPage>

  const state = getState();
  const shouldAutoDownload = false; // makeSelectClientSetting(SETTINGS.AUTO_DOWNLOAD)(state);
  const savedSubscription = state.subscriptions.subscriptions.find(
    sub => sub.uri === subscriptionUri
  );

  if (!savedSubscription) {
    throw Error(
      `Trying to find new content for ${subscriptionUri} but it doesn't exist in your subscriptions`
    );
  }

  // We may be duplicating calls here. Can this logic be baked into doFetchClaimsByChannel?
  Lbry.claim_search({
    channel: subscriptionUri,
    page: 1,
    page_size: PAGE_SIZE,
    valid_channel_signature: true,
    order_by: ['release_time'],
  }).then(result => {
    const { items: claimsInChannel } = result;

    // may happen if subscribed to an abandoned channel or an empty channel
    if (!claimsInChannel || !claimsInChannel.length) {
      return;
    }

    // Determine if the latest subscription currently saved is actually the latest subscription
    const latestIndex = claimsInChannel.findIndex(
      claim => `${claim.name}#${claim.claim_id}` === savedSubscription.latest
    );

    // If latest is -1, it is a newly subscribed channel or there have been 10+ claims published since last viewed
    const latestIndexToNotify = latestIndex === -1 ? 10 : latestIndex;

    // If latest is 0, nothing has changed
    // Do not download/notify about new content, it would download/notify 10 claims per channel
    if (latestIndex !== 0 && savedSubscription.latest) {
      let downloadCount = 0;

      const newUnread = [];
      claimsInChannel.slice(0, latestIndexToNotify).forEach(claim => {
        const uri = buildURI({ contentName: claim.name, claimId: claim.claim_id }, true);
        const shouldDownload =
          shouldAutoDownload &&
          Boolean(downloadCount < SUBSCRIPTION_DOWNLOAD_LIMIT && !claim.value.stream.metadata.fee);

        // Add the new content to the list of "un-read" subscriptions
        if (shouldNotify) {
          newUnread.push(uri);
        }

        if (shouldDownload) {
          downloadCount += 1;
          dispatch(doPurchaseUri(uri, { cost: 0 }, true));
        }
      });

      dispatch(
        doUpdateUnreadSubscriptions(
          subscriptionUri,
          newUnread,
          downloadCount > 0 ? NOTIFICATION_TYPES.DOWNLOADING : NOTIFICATION_TYPES.NOTIFY_ONLY
        )
      );
    }

    // Set the latest piece of content for a channel
    // This allows the app to know if there has been new content since it was last set
    dispatch(
      setSubscriptionLatest(
        {
          channelName: claimsInChannel[0].channel_name,
          uri: buildURI(
            {
              channelName: claimsInChannel[0].channel_name,
              claimId: claimsInChannel[0].claim_id,
            },
            false
          ),
        },
        buildURI(
          { contentName: claimsInChannel[0].name, claimId: claimsInChannel[0].claim_id },
          false
        )
      )
    );

    // calling FETCH_CHANNEL_CLAIMS_COMPLETED after not calling STARTED
    // means it will delete a non-existant fetchingChannelClaims[uri]
    dispatch({
      type: ACTIONS.FETCH_CHANNEL_CLAIMS_COMPLETED,
      data: {
        uri: subscriptionUri,
        claims: claimsInChannel || [],
        page: 1,
      },
    });
  });
};

export const doChannelSubscribe = (subscription: Subscription) => (
  dispatch: ReduxDispatch,
  getState: GetState
) => {
  const {
    settings: { daemonSettings },
  } = getState();

  const isSharingData = daemonSettings ? daemonSettings.share_usage_data : true;

  const subscriptionUri = subscription.uri;
  if (!subscriptionUri.startsWith('lbry://')) {
    throw Error(
      `Subscription uris must inclue the "lbry://" prefix.\nTried to subscribe to ${subscriptionUri}`
    );
  }

  dispatch({
    type: ACTIONS.CHANNEL_SUBSCRIBE,
    data: subscription,
  });

  // if the user isn't sharing data, keep the subscriptions entirely in the app
  if (isSharingData) {
    const { claimId } = parseURI(subscription.uri);
    // They are sharing data, we can store their subscriptions in our internal database
    Lbryio.call('subscription', 'new', {
      channel_name: subscription.channelName,
      claim_id: claimId,
    });

    dispatch(doClaimRewardType(rewards.TYPE_SUBSCRIPTION, { failSilently: true }));
  }

  dispatch(doCheckSubscription(subscription.uri, true));
};

export const doChannelUnsubscribe = (subscription: Subscription) => (
  dispatch: ReduxDispatch,
  getState: GetState
) => {
  const {
    settings: { daemonSettings },
  } = getState();
  const isSharingData = daemonSettings ? daemonSettings.share_usage_data : true;

  dispatch({
    type: ACTIONS.CHANNEL_UNSUBSCRIBE,
    data: subscription,
  });

  if (isSharingData) {
    const { claimId } = parseURI(subscription.uri);
    Lbryio.call('subscription', 'delete', {
      claim_id: claimId,
    });
  }
};

export const doCheckSubscriptions = () => (dispatch: ReduxDispatch, getState: GetState) => {
  const state = getState();
  const subscriptions = selectSubscriptions(state);

  subscriptions.forEach((sub: Subscription) => {
    dispatch(doCheckSubscription(sub.uri, true));
  });
};

export const doFetchMySubscriptions = () => (dispatch: ReduxDispatch, getState: GetState) => {
  const state: { subscriptions: SubscriptionState, settings: any } = getState();
  const { subscriptions: reduxSubscriptions } = state.subscriptions;

  // default to true if daemonSettings not found
  const isSharingData =
    state.settings && state.settings.daemonSettings
      ? state.settings.daemonSettings.share_usage_data
      : true;

  if (!isSharingData && isSharingData !== undefined) {
    // They aren't sharing their data, subscriptions will be handled by persisted redux state
    return;
  }

  // most of this logic comes from scenarios where the db isn't synced with redux
  // this will happen if the user stops sharing data
  dispatch({ type: ACTIONS.FETCH_SUBSCRIPTIONS_START });

  Lbryio.call('subscription', 'list')
    .then(dbSubscriptions => {
      const storedSubscriptions = dbSubscriptions || [];

      // User has no subscriptions in db or redux
      if (!storedSubscriptions.length && (!reduxSubscriptions || !reduxSubscriptions.length)) {
        return [];
      }

      // There is some mismatch between redux state and db state
      // If something is in the db, but not in redux, add it to redux
      // If something is in redux, but not in the db, add it to the db
      if (storedSubscriptions.length !== reduxSubscriptions.length) {
        const dbSubMap = {};
        const reduxSubMap = {};
        const subsNotInDB = [];
        const subscriptionsToReturn = reduxSubscriptions.slice();

        storedSubscriptions.forEach(sub => {
          dbSubMap[sub.claim_id] = 1;
        });

        reduxSubscriptions.forEach(sub => {
          const { claimId } = parseURI(sub.uri);
          reduxSubMap[claimId] = 1;

          if (!dbSubMap[claimId]) {
            subsNotInDB.push({
              claim_id: claimId,
              channel_name: sub.channelName,
            });
          }
        });

        storedSubscriptions.forEach(sub => {
          if (!reduxSubMap[sub.claim_id]) {
            const uri = `lbry://${sub.channel_name}#${sub.claim_id}`;
            subscriptionsToReturn.push({ uri, channelName: sub.channel_name });
          }
        });

        return Promise.all(subsNotInDB.map(payload => Lbryio.call('subscription', 'new', payload)))
          .then(() => subscriptionsToReturn)
          .catch(
            () =>
              // let it fail, we will try again when the navigate to the subscriptions page
              subscriptionsToReturn
          );
      }

      // DB is already synced, just return the subscriptions in redux
      return reduxSubscriptions;
    })
    .then((subscriptions: Array<Subscription>) => {
      dispatch({
        type: ACTIONS.FETCH_SUBSCRIPTIONS_SUCCESS,
        data: subscriptions,
      });

      dispatch(doResolveUris(subscriptions.map(({ uri }) => uri)));
      dispatch(doCheckSubscriptions());
    })
    .catch(() => {
      dispatch({
        type: ACTIONS.FETCH_SUBSCRIPTIONS_FAIL,
      });
    });
};

export const doCheckSubscriptionsInit = () => (dispatch: ReduxDispatch) => {
  // doCheckSubscriptionsInit is called by doDaemonReady
  // setTimeout below is a hack to ensure redux is hydrated when subscriptions are checked
  // this will be replaced with <PersistGate> which reqiures a package upgrade
  setTimeout(() => dispatch(doFetchMySubscriptions()), 5000);
  const checkSubscriptionsTimer = setInterval(
    () => dispatch(doCheckSubscriptions()),
    CHECK_SUBSCRIPTIONS_INTERVAL
  );
  dispatch({
    type: ACTIONS.CHECK_SUBSCRIPTIONS_SUBSCRIBE,
    data: { checkSubscriptionsTimer },
  });
  setInterval(() => dispatch(doCheckSubscriptions()), CHECK_SUBSCRIPTIONS_INTERVAL);
};

export const doFetchRecommendedSubscriptions = () => (dispatch: ReduxDispatch) => {
  dispatch({
    type: ACTIONS.GET_SUGGESTED_SUBSCRIPTIONS_START,
  });

  return Lbryio.call('subscription', 'suggest')
    .then(suggested =>
      dispatch({
        type: ACTIONS.GET_SUGGESTED_SUBSCRIPTIONS_SUCCESS,
        data: suggested,
      })
    )
    .catch(error =>
      dispatch({
        type: ACTIONS.GET_SUGGESTED_SUBSCRIPTIONS_FAIL,
        error,
      })
    );
};

export const doCompleteFirstRun = () => (dispatch: ReduxDispatch) =>
  dispatch({
    type: ACTIONS.SUBSCRIPTION_FIRST_RUN_COMPLETED,
  });

export const doShowSuggestedSubs = () => (dispatch: ReduxDispatch) =>
  dispatch({
    type: ACTIONS.VIEW_SUGGESTED_SUBSCRIPTIONS,
  });

export const doChannelSubscriptionEnableNotifications = (channelName: string) => (
  dispatch: ReduxDispatch
) =>
  dispatch({
    type: ACTIONS.CHANNEL_SUBSCRIPTION_ENABLE_NOTIFICATIONS,
    data: channelName,
  });

export const doChannelSubscriptionDisableNotifications = (channelName: string) => (
  dispatch: ReduxDispatch
) =>
  dispatch({
    type: ACTIONS.CHANNEL_SUBSCRIPTION_DISABLE_NOTIFICATIONS,
    data: channelName,
  });
