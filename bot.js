// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const { ActivityTypes, TurnContext } = require('botbuilder');
const { DialogSet, TextPrompt, WaterfallDialog } = require('botbuilder-dialogs');

const DIALOG_STATE_PROPERTY = 'dialog_state';
const USER_PROFILE_PROPERTY = 'user';

const WHO_ARE_YOU = 'who_are_you';
const HELLO_USER = 'hello_user';

const NAME_PROMPT = 'name_prompt';
const CITY_PROMPT = 'city_prompt';

const JOBS_LIST = 'jobs';

class ProactiveBot {
    /**
     *
     * @param {BotState} botState A BotState object used to store information for the bot independent of user or conversation.
     * @param {BotAdapter} adapter A BotAdapter used to send and receive messages.
     */
    constructor(conversationState, userState, botState, adapter) {
        this.converstationState = conversationState;
        this.userState = userState;
        this.botState = botState;
        this.adapter = adapter;

        this.dialogState = this.converstationState.createProperty(DIALOG_STATE_PROPERTY);
        this.userProfile = this.userState.createProperty(USER_PROFILE_PROPERTY);

        this.dialogs = new DialogSet(this.dialogState);

        this.dialogs.add(new TextPrompt(NAME_PROMPT));
        this.dialogs.add(new TextPrompt(CITY_PROMPT));

        this.dialogs.add(new WaterfallDialog(WHO_ARE_YOU, [
            this.promptForName.bind(this),
            this.promptForCity.bind(this),
            this.captureCity.bind(this)
        ]));

        this.dialogs.add(new WaterfallDialog(HELLO_USER, [
            this.displayProfile.bind(this)
        ]));

        this.jobsList = this.botState.createProperty(JOBS_LIST);
    }

    async promptForName(step) {
        return await step.prompt(NAME_PROMPT, `What is your name?`);
    }

    async promptForCity(step) {
        const user = await this.userProfile.get(step.context, {});
        user.name = step.result;

        await this.userProfile.set(step.context, user);
        return await step.prompt(CITY_PROMPT, `What city are you from?`);
    }

    async captureCity(step) {
        const user = await this.userProfile.get(step.context, {});
        user.city = step.result;

        await this.userProfile.set(step.context, user);
        return await step.endDialog();
    }

    async displayProfile(step){
        const user = await this.userProfile.get(step.context, {});
        await step.context.sendActivity(`Hello, ${user.name} from ${user.city}`);
        return await step.endDialog();
    }

    /**
     *
     * @param {TurnContext} turnContext A TurnContext object representing an incoming message to be handled by the bot.
     */
    async onTurn(turnContext) {
        // See https://aka.ms/about-bot-activity-message to learn more about the message and other activity types.
        if (turnContext.activity.type === ActivityTypes.Message) {
            const utterance = (turnContext.activity.text || '').trim().toLowerCase();
            var jobIdNumber;
            
            const dc = await this.dialogs.createContext(turnContext);

            // If user types in run, create a new job.
            if (utterance === 'run') {
                await this.createJob(turnContext);
            } else if (utterance === 'show') {
                await this.showJobs(turnContext);
            } else if (utterance.split(' ')[0] === 'done') {
                const words = utterance.split(' ');

                // If the user types done and a Job Id Number,
                // we check if the second word input is a number.
                if (!isNaN(parseInt(words[1]))) {
                    jobIdNumber = words[1];
                    await this.completeJob(turnContext, jobIdNumber);
                } else if (words[0] === 'done' && (words.length < 2 || isNaN(parseInt(words[1])))) {
                    await turnContext.sendActivity('Enter the job ID number after "done".');
                }
            } 

            if (!turnContext.responded) {
                await dc.continueDialog();
                
            }
        } else if (turnContext.activity.type === ActivityTypes.Event && turnContext.activity.name === 'jobCompleted') {
            jobIdNumber = turnContext.activity.value;
            if (!isNaN(parseInt(jobIdNumber))) {
                await this.completeJob(turnContext, jobIdNumber);
            }
        } else if (
            turnContext.activity.type === ActivityTypes.ConversationUpdate &&
             turnContext.activity.membersAdded[0].name !== 'Bot'
        ) {
            await turnContext.sendActivity(`Say "run" to start a job, "show" to view running jobs, or "done <job number>" to complete a job.`);
        }
        await this.userState.saveChanges(turnContext);
        await this.converstationState.saveChanges(turnContext);
        await this.botState.saveChanges(turnContext);
    }

    // Save job ID and conversation reference.
    async createJob(turnContext) {
        // Create a unique job ID.
        var date = new Date();
        var jobIdNumber = date.getMilliseconds();
        
        // Get the conversation reference.
        const reference = TurnContext.getConversationReference(turnContext.activity);

        // Get the list of jobs. Default it to {} if it is empty.
        const jobs = await this.jobsList.get(turnContext, {});

        // Try to find previous information about the saved job.
        const jobInfo = jobs[jobIdNumber];

        try {
            if (isEmpty(jobInfo)) {
                // Job object is empty so we have to create it
                await turnContext.sendActivity(`Need to create new job ID: ${ jobIdNumber }`);

                // Update jobInfo with new info
                jobs[jobIdNumber] = { completed: false, reference: reference };

                try {
                    // Save to storage
                    await this.jobsList.set(turnContext, jobs);
                    // Notify the user that the job has been processed
                    await turnContext.sendActivity('Successful write to log.');
                } catch (err) {
                    await turnContext.sendActivity(`Write failed: ${ err.message }`);
                }
            }
        } catch (err) {
            await turnContext.sendActivity(`Read rejected. ${ err.message }`);
        }
    }

    async completeJob(turnContext, jobIdNumber) {
        // Get the list of jobs from the bot's state property accessor.
        const jobs = await this.jobsList.get(turnContext, {});

        // Find the appropriate job in the list of jobs.
        let jobInfo = jobs[jobIdNumber];

        // If no job was found, notify the user of this error state.
        if (isEmpty(jobInfo)) {
            await turnContext.sendActivity(`Sorry no job with ID ${ jobIdNumber }.`);
        } else {
            // Found a job with the ID passed in.
            const reference = jobInfo.reference;
            const completed = jobInfo.completed;

            // If the job is not yet completed and conversation reference exists,
            // use the adapter to continue the conversation with the job's original creator.
            if (reference && !completed) {
                // Since we are going to proactively send a message to the user who started the job,
                // we need to create the turnContext based on the stored reference value.
                await this.adapter.continueConversation(reference, async (proactiveTurnContext) => {
                    // Complete the job.
                    jobInfo.completed = true;
                    // Save the updated job.
                    await this.jobsList.set(turnContext, jobs);
                    // Notify the user that the job is complete.
                    await proactiveTurnContext.sendActivity(`Your queued job ${ jobIdNumber } just completed.`);

                    const dc = await this.dialogs.createContext(proactiveTurnContext);

                    const user = await this.userProfile.get(proactiveTurnContext, {});
                    if (user.city) {
                        await dc.beginDialog(HELLO_USER);
                    } else {
                        await dc.beginDialog(WHO_ARE_YOU);
                    }
                    await this.converstationState.saveChanges(proactiveTurnContext);
                });

                // Send a message to the person who completed the job.
                await turnContext.sendActivity('Job completed. Notification sent.');
            } else if (completed) { // The job has already been completed.
                await turnContext.sendActivity('This job is already completed, please start a new job.');
            };
        };
    };

    // Show a list of the pending jobs
    async showJobs(turnContext) {
        const jobs = await this.jobsList.get(turnContext, {});
        if (Object.keys(jobs).length) {
            await turnContext.sendActivity(
                '| Job number &nbsp; | Conversation ID &nbsp; | Completed |<br>' +
                '| :--- | :---: | :---: |<br>' +
                Object.keys(jobs).map((key) => {
                    return `${ key } &nbsp; | ${ jobs[key].reference.conversation.id.split('|')[0] } &nbsp; | ${ jobs[key].completed }`;
                }).join('<br>'));
        } else {
            await turnContext.sendActivity('The job log is empty.');
        }
    }
}

// Helper function to check if object is empty.
function isEmpty(obj) {
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            return false;
        }
    }
    return true;
};

module.exports.ProactiveBot = ProactiveBot;
