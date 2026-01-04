'use strict';

const Homey = require('homey');
const { DEVICE_MATCH_STATUS } = require('../../lib/constants');

class TeamDriver extends Homey.Driver {
  async onInit() {
    this.log('TeamDriver initialized');

    // Register flow condition cards (once, at driver level)
    this.registerFlowCards();
  }

  registerFlowCards() {
    // is_playing condition
    this.homey.flow.getConditionCard('is_playing')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        const matchStatus = device.getCapabilityValue('match_status');

        // Check capability first
        if (matchStatus === DEVICE_MATCH_STATUS.LIVE ||
            matchStatus === DEVICE_MATCH_STATUS.HALFTIME) {
          return true;
        }

        // Also check if match is probably live (kickoff passed, within 2 hours)
        const matchManager = this.homey.app.matchManager;
        if (matchManager) {
          const liveMatch = matchManager.getTeamLiveMatch(device.teamId);
          if (liveMatch) return true;

          // Check for match that should be live (API delayed)
          const matchToday = matchManager.getTeamMatchToday(device.teamId);
          if (matchToday) {
            const kickoffTime = new Date(matchToday.utcDate || matchToday.kickoffTime);
            const now = new Date();
            const minutesSinceKickoff = (now - kickoffTime) / 1000 / 60;
            // If kickoff was 0-120 minutes ago, consider it playing
            if (minutesSinceKickoff > 0 && minutesSinceKickoff < 120) {
              this.log(`is_playing: match probably live (${Math.round(minutesSinceKickoff)} min since kickoff)`);
              return true;
            }
          }
        }

        return false;
      });

    // is_winning condition
    this.homey.flow.getConditionCard('is_winning')
      .registerRunListener(async (args, state) => {
        return args.device.isWinning();
      });

    // is_losing condition
    this.homey.flow.getConditionCard('is_losing')
      .registerRunListener(async (args, state) => {
        return args.device.isLosing();
      });

    // is_drawing condition
    this.homey.flow.getConditionCard('is_drawing')
      .registerRunListener(async (args, state) => {
        return args.device.isDrawing();
      });

    // has_match_today condition
    this.homey.flow.getConditionCard('has_match_today')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        const matchManager = this.homey.app.matchManager;
        const matchToday = matchManager?.getTeamMatchToday(device.teamId);
        return matchToday !== null;
      });

    // match_within_hours condition
    this.homey.flow.getConditionCard('match_within_hours')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        const matchManager = this.homey.app.matchManager;
        const nextMatch = await matchManager?.getTeamNextMatch(device.teamId);
        if (!nextMatch) return false;
        const hoursUntil = (new Date(nextMatch.utcDate) - new Date()) / 1000 / 60 / 60;
        return hoursUntil <= args.hours && hoursUntil > 0;
      });

    // match_starts_soon trigger run listener (for minutes filter)
    this.homey.flow.getDeviceTriggerCard('match_starts_soon')
      .registerRunListener(async (args, state) => {
        return args.minutes === state.minutes;
      });

    // Action cards
    this.registerActionCards();

    this.log('Flow cards registered');
  }

  registerActionCards() {
    // get_next_match action
    this.homey.flow.getActionCard('get_next_match')
      .registerRunListener(async (args) => {
        const device = args.device;
        const matchManager = this.homey.app.matchManager;

        if (!matchManager) {
          throw new Error('MatchManager not available');
        }

        const nextMatch = await matchManager.getTeamNextMatch(device.teamId);

        if (!nextMatch) {
          throw new Error('No upcoming match found');
        }

        const isHome = nextMatch.homeTeam.id === Number(device.teamId);
        const opponent = isHome ? nextMatch.awayTeam : nextMatch.homeTeam;
        const matchDate = new Date(nextMatch.utcDate);
        const timezone = this.homey.clock.getTimezone();
        const daysUntil = Math.ceil((matchDate - new Date()) / 1000 / 60 / 60 / 24);

        // Format date in Homey timezone (yyyy-mm-dd)
        const dateStr = matchDate.toLocaleDateString('en-CA', { timeZone: timezone });
        // Format time in Homey timezone
        const timeStr = matchDate.toLocaleTimeString('nl-NL', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: timezone,
        });

        return {
          opponent: opponent.shortName || opponent.name,
          date: dateStr,
          time: timeStr,
          competition: nextMatch.competition?.name || '',
          venue: isHome ? 'Home' : 'Away',
          is_home: isHome,
          days_until: daysUntil,
        };
      });

    // get_current_score action
    this.homey.flow.getActionCard('get_current_score')
      .registerRunListener(async (args) => {
        const device = args.device;
        const matchManager = this.homey.app.matchManager;

        if (!matchManager) {
          throw new Error('MatchManager not available');
        }

        const liveMatch = matchManager.getTeamLiveMatch(device.teamId);

        if (!liveMatch) {
          // Return default values when no live match
          return {
            home_team: '',
            away_team: '',
            home_score: 0,
            away_score: 0,
            score: 'No live match',
            minute: 0,
            status: 'IDLE',
            is_live: false,
          };
        }

        const homeScore = liveMatch.homeScore ?? 0;
        const awayScore = liveMatch.awayScore ?? 0;

        return {
          home_team: liveMatch.homeTeamName || '',
          away_team: liveMatch.awayTeamName || '',
          home_score: homeScore,
          away_score: awayScore,
          score: `${homeScore}-${awayScore}`,
          minute: liveMatch.minute || 0,
          status: liveMatch.status || 'UNKNOWN',
          is_live: true,
        };
      });

    this.log('Action cards registered');
  }

  async onPair(session) {
    this.log('onPair called, setting up handlers...');
    let selectedCompetition = null;

    // Check API key upfront
    const apiKey = this.homey.settings.get('apiKey');
    if (!apiKey) {
      this.error('No API key configured');
    }

    // Get available competitions from API
    session.setHandler('get_competitions', async () => {
      this.log('[get_competitions] Loading competitions...');

      if (!apiKey) {
        throw new Error('Please configure your API key in app settings first');
      }

      try {
        const api = this.homey.app.api;
        const competitions = await api.getCompetitions();
        this.log(`[get_competitions] Found ${competitions.length} competitions`);
        return competitions;
      } catch (error) {
        this.error('[get_competitions] Error:', error.message);
        throw error;
      }
    });

    // Handle competition selection
    session.setHandler('select_competition', async (competition) => {
      this.log(`[select_competition] Selected: ${competition.name} (${competition.code})`);
      selectedCompetition = competition;
      await session.showView('select_team');
    });

    // Get teams for selected competition
    session.setHandler('get_teams', async () => {
      this.log(`[get_teams] Loading teams for ${selectedCompetition?.name}...`);

      if (!selectedCompetition) {
        throw new Error('No competition selected');
      }

      try {
        const api = this.homey.app.api;
        const result = await api.getCompetitionTeams(selectedCompetition.code);
        const teams = result.teams.map(team => ({
          id: team.id,
          name: team.name,
          shortName: team.shortName,
          tla: team.tla,
          crest: team.crest,
          competition: selectedCompetition.name,
          competitionCode: selectedCompetition.code,
        }));
        this.log(`[get_teams] Found ${teams.length} teams`);
        return teams;
      } catch (error) {
        this.error('[get_teams] Error:', error.message);
        throw error;
      }
    });

    // Device is created directly via Homey.createDevice() in the frontend
  }

  createDeviceFromTeam(team) {
    return {
      name: team.name,
      data: {
        id: String(team.id),
      },
      store: {
        teamName: team.name,
        teamShortName: team.shortName || team.name,
        teamTla: team.tla || '',
        competition: team.competition,
        competitionCode: team.competitionCode,
        crest: team.crest,
      },
    };
  }

  async onRepair(session, device) {
    // Repair not needed for this driver
  }
}

module.exports = TeamDriver;
